//! Disk usage (system df), cleanup (prune) and the automatic cleanup schedule.
use crate::state::AppState;
use crate::store::Schedule;
use crate::util::*;
use bollard::query_parameters::*;
use chrono::{Datelike, Duration as CDuration, Local, TimeZone};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

fn arr<'a>(v: &'a Value, legacy: &str, new_path: &[&str]) -> Vec<&'a Value> {
    if let Some(a) = v.get(legacy).and_then(|x| x.as_array()) {
        return a.iter().collect();
    }
    let mut cur = v;
    for k in new_path {
        cur = &cur[*k];
    }
    cur.as_array().map(|a| a.iter().collect()).unwrap_or_default()
}

#[tauri::command]
pub async fn system_df(state: State<'_, AppState>) -> CmdResult<Value> {
    let d = state.docker()?;
    let endpoint = state.active().endpoint;
    // Prefer the raw GET (stable legacy format); otherwise use bollard (new format).
    let v = match tokio::time::timeout(Duration::from_secs(60), crate::rawapi::get_json(&endpoint, "/system/df")).await {
        Ok(Ok(v)) => v,
        _ => {
            let r = tokio::time::timeout(Duration::from_secs(60), d.df(Some(DataUsageOptionsBuilder::new().build())))
                .await
                .map_err(|_| "system df timed out".to_string())?
                .map_err(derr)?;
            to_v(&r)
        }
    };
    let images = arr(&v, "Images", &["ImageUsage", "Items"]);
    let volumes = arr(&v, "Volumes", &["VolumeUsage", "Items"]);
    let cache = arr(&v, "BuildCache", &["BuildCacheUsage", "Items"]);
    let containers = arr(&v, "Containers", &["ContainerUsage", "Items"]);
    let vol_rows: Vec<Value> = volumes
        .iter()
        .map(|x| json!({ "name": s(x, "Name"), "size": x["UsageData"]["Size"].as_i64().unwrap_or(-1), "refCount": x["UsageData"]["RefCount"].as_i64().unwrap_or(-1) }))
        .collect();
    let vol_total: i64 = vol_rows.iter().map(|x| x["size"].as_i64().unwrap_or(0).max(0)).sum();
    let cache_rows: Vec<Value> = cache
        .iter()
        // Same as `docker system df`: a Shared record shares layers with another record, so it is not summed.
        .filter(|x| !x["Shared"].as_bool().unwrap_or(false))
        .map(|x| json!({ "id": s(x, "ID"), "description": s(x, "Description"), "size": i(x, "Size"), "inUse": x["InUse"].as_bool().unwrap_or(false), "type": s(x, "Type") }))
        .collect();
    let cache_total: i64 = cache_rows.iter().map(|x| x["size"].as_i64().unwrap_or(0)).sum();
    let ctr_total: i64 = containers.iter().map(|x| x["SizeRw"].as_i64().unwrap_or(0).max(0)).sum();
    let ctr_sizes: serde_json::Map<String, Value> = containers
        .iter()
        .map(|x| (s(x, "Id"), json!(x["SizeRw"].as_i64().unwrap_or(0).max(0))))
        .collect();
    let mut layers = v["LayersSize"].as_i64().unwrap_or(0);
    if layers <= 0 {
        // The containerd-style image store does not return LayersSize: sum each image's size.
        layers = images.iter().map(|x| x["Size"].as_i64().unwrap_or(0).max(0)).sum();
    }
    Ok(json!({
        "imagesSize": layers,
        "volumesSize": vol_total,
        "cacheSize": cache_total,
        "containersSize": ctr_total,
        "volumes": vol_rows,
        "cache": cache_rows,
        "containerSizes": ctr_sizes,
    }))
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PruneSel {
    #[serde(default)]
    pub containers: bool,
    #[serde(default)]
    pub images: bool,
    #[serde(default)]
    pub networks: bool,
    #[serde(default)]
    pub cache: bool,
    #[serde(default)]
    pub volumes: bool,
    pub keep_cache_days: Option<u32>,
}

async fn do_prune(d: &bollard::Docker, sel: &PruneSel) -> Value {
    let mut reclaimed: HashMap<&str, u64> = HashMap::new();
    let mut errors: Vec<String> = Vec::new();
    if sel.containers {
        match d.prune_containers(None::<PruneContainersOptions>).await {
            Ok(r) => {
                reclaimed.insert("containers", r.space_reclaimed.unwrap_or(0).max(0) as u64);
            }
            Err(e) => errors.push(format!("containers: {}", derr(e))),
        }
    }
    if sel.images {
        let mut f: HashMap<String, Vec<String>> = HashMap::new();
        f.insert("dangling".into(), vec!["true".into()]);
        match d.prune_images(Some(PruneImagesOptionsBuilder::new().filters(&f).build())).await {
            Ok(r) => {
                reclaimed.insert("images", r.space_reclaimed.unwrap_or(0).max(0) as u64);
            }
            Err(e) => errors.push(format!("images: {}", derr(e))),
        }
    }
    if sel.networks {
        match d.prune_networks(None::<PruneNetworksOptions>).await {
            Ok(_) => {
                reclaimed.insert("networks", 0);
            }
            Err(e) => errors.push(format!("networks: {}", derr(e))),
        }
    }
    if sel.cache {
        let mut b = PruneBuildOptionsBuilder::new().all(true);
        let mut f: HashMap<String, Vec<String>> = HashMap::new();
        if let Some(days) = sel.keep_cache_days {
            f.insert("until".into(), vec![format!("{}h", days * 24)]);
            b = b.filters(&f);
        }
        match d.prune_build(Some(b.build())).await {
            Ok(r) => {
                reclaimed.insert("cache", r.space_reclaimed.unwrap_or(0).max(0) as u64);
            }
            Err(e) => errors.push(format!("cache: {}", derr(e))),
        }
    }
    if sel.volumes {
        let mut f: HashMap<String, Vec<String>> = HashMap::new();
        f.insert("all".into(), vec!["true".into()]);
        match d.prune_volumes(Some(PruneVolumesOptionsBuilder::new().filters(&f).build())).await {
            Ok(r) => {
                reclaimed.insert("volumes", r.space_reclaimed.unwrap_or(0).max(0) as u64);
            }
            Err(e) => errors.push(format!("volumes: {}", derr(e))),
        }
    }
    let total: u64 = reclaimed.values().sum();
    json!({ "reclaimed": reclaimed, "total": total, "errors": errors })
}

#[tauri::command]
pub async fn prune_run<R: Runtime>(app: AppHandle<R>, state: State<'_, AppState>, selection: PruneSel) -> CmdResult<Value> {
    let d = state.docker()?;
    let r = do_prune(&d, &selection).await;
    let _ = app.emit("prune://done", r.clone());
    Ok(r)
}

// ---------- automatic schedule ----------

#[tauri::command]
pub fn schedule_get(state: State<'_, AppState>) -> Schedule {
    let ctx = state.active().id;
    state.store.lock().unwrap().schedules.get(&ctx).cloned().unwrap_or_else(|| Schedule::default_for(&ctx))
}

#[tauri::command]
pub fn schedule_set(state: State<'_, AppState>, mut schedule: Schedule) -> Schedule {
    let ctx = state.active().id;
    schedule.context_id = ctx.clone();
    // Reference point for the next run: the time the schedule was saved (if it never ran).
    let prev = state.store.lock().unwrap().schedules.get(&ctx).cloned();
    if schedule.last_run_at.is_none() {
        schedule.last_run_at = prev.and_then(|p| p.last_run_at).or_else(|| Some(now_iso()));
    }
    state.with_store(|s| {
        s.schedules.insert(ctx, schedule.clone());
    });
    schedule
}

/// Next run after `after`: daily 02:00, Sunday 02:00, or the 1st at 02:00.
pub fn next_due(freq: &str, after: chrono::DateTime<Local>) -> chrono::DateTime<Local> {
    let at2 = |d: chrono::NaiveDate| Local.from_local_datetime(&d.and_hms_opt(2, 0, 0).unwrap()).earliest().unwrap_or(after);
    let mut day = after.date_naive();
    for _ in 0..400 {
        let cand = at2(day);
        let ok = match freq {
            "daily" => true,
            "monthly" => day.day() == 1,
            _ => day.weekday() == chrono::Weekday::Sun,
        };
        if ok && cand > after {
            return cand;
        }
        day += CDuration::days(1);
    }
    after + CDuration::days(7)
}

/// Background loop: every minute check the active context's schedule; if it is overdue (even while the app was off) run it to catch up.
pub fn start_scheduler<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let st = app.state::<AppState>();
            let ctx = st.active().id;
            let Some(sc) = st.store.lock().unwrap().schedules.get(&ctx).cloned() else { continue };
            if !sc.enabled {
                continue;
            }
            let Some(d) = st.docker.lock().unwrap().clone() else { continue };
            let last = sc
                .last_run_at
                .as_deref()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.with_timezone(&Local))
                .unwrap_or_else(Local::now);
            if Local::now() < next_due(&sc.freq, last) {
                continue;
            }
            // Volumes are never cleaned automatically.
            let sel = PruneSel {
                containers: sc.containers,
                images: sc.dangling_images,
                networks: false,
                cache: sc.build_cache,
                volumes: false,
                keep_cache_days: Some(sc.keep_cache_days),
            };
            let r = do_prune(&d, &sel).await;
            let total = r["total"].as_u64().unwrap_or(0);
            st.with_store(|s| {
                if let Some(x) = s.schedules.get_mut(&ctx) {
                    x.last_run_at = Some(now_iso());
                    x.last_reclaimed_bytes = Some(total);
                }
            });
            let _ = app.emit("prune://done", json!({ "auto": true, "total": total, "reclaimed": r["reclaimed"], "errors": r["errors"] }));
        }
    });
}
