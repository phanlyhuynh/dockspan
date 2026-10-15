//! Integration tests against real Docker (Tauri's mock app).
//! Run: `cargo test -- --ignored --nocapture --test-threads=1`
//! Only touches resources with the `dockspan-smoke` prefix; does NOT run prune.
use crate::state::AppState;
use crate::{containers, ctx, events, images, netvol, projects, prune, store::Store};
use base64::Engine;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::test::{mock_app, MockRuntime};
use tauri::{App, Listener, Manager};

const IMG: &str = "alpine:3.20";
const PREFIX: &str = "dockspan-smoke";

fn mk_app() -> App<MockRuntime> {
    let app = mock_app();
    let dir = std::env::temp_dir().join("dockspan-smoke-store");
    let _ = std::fs::remove_dir_all(&dir);
    let store = Store::load(dir.join("store.json"));
    let active = ctx::initial_context(&store);
    app.manage(AppState {
        docker: StdMutex::new(None),
        active: StdMutex::new(active),
        info: StdMutex::new(None),
        tasks: StdMutex::new(HashMap::new()),
        execs: tokio::sync::Mutex::new(HashMap::new()),
        store: StdMutex::new(store),
        bridge: StdMutex::new(None),
    });
    app
}

fn collect(app: &App<MockRuntime>, event: &str) -> Arc<StdMutex<Vec<String>>> {
    let buf = Arc::new(StdMutex::new(Vec::new()));
    let b2 = buf.clone();
    app.listen(event, move |e| b2.lock().unwrap().push(e.payload().to_string()));
    buf
}

async fn wait_for(buf: &Arc<StdMutex<Vec<String>>>, needle: &str, secs: u64) -> bool {
    for _ in 0..secs * 10 {
        if buf.lock().unwrap().iter().any(|s| s.contains(needle)) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

async fn wait_docker(st: &AppState) {
    for _ in 0..100 {
        if st.docker.lock().unwrap().is_some() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    panic!("Docker is not running");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn engine_and_docker_flow() {
    let app = mk_app();
    let h = app.handle().clone();
    let st = h.state::<AppState>();
    println!("context: {:?}", st.active());

    // --- start the engine if it is stopped (calls exactly the command the "Start" button uses) ---
    let status = events::engine_status(h.state()).await.unwrap();
    println!("initial engine_status: {}", status["state"]);
    if status["state"] != "on" {
        println!("Engine stopped -> engine_start");
        events::engine_start(h.state()).await.expect("engine_start");
    }
    events::start_monitor(&h);
    wait_docker(&st).await;
    let status = events::engine_status(h.state()).await.unwrap();
    assert_eq!(status["state"], "on", "{status}");
    println!("Docker {} · {}", status["info"]["version"], status["info"]["os"]);

    // --- clean up leftovers from a previous run ---
    for c in containers::containers_list(h.state()).await.unwrap() {
        if c["name"].as_str().unwrap().starts_with(PREFIX) {
            containers::container_remove(h.state(), c["id"].as_str().unwrap().into(), true).await.ok();
        }
    }

    for n in netvol::networks_list(h.state()).await.unwrap() {
        if n["name"].as_str().unwrap().starts_with(PREFIX) {
            netvol::network_remove(h.state(), n["id"].as_str().unwrap().into()).await.ok();
        }
    }
    for v in netvol::volumes_list(h.state()).await.unwrap() {
        if v["name"].as_str().unwrap().starts_with(PREFIX) {
            netvol::volume_remove(h.state(), v["name"].as_str().unwrap().into()).await.ok();
        }
    }

    // --- read the lists ---
    let cl = containers::containers_list(h.state()).await.unwrap();
    let il = images::images_list(h.state()).await.unwrap();
    let nl = netvol::networks_list(h.state()).await.unwrap();
    let vl = netvol::volumes_list(h.state()).await.unwrap();
    println!("containers={} images={} networks={} volumes={}", cl.len(), il.len(), nl.len(), vl.len());
    assert!(nl.iter().any(|n| n["name"] == "bridge" && n["system"] == true));
    let df = prune::system_df(h.state()).await.unwrap();
    println!("df: {}", df.to_string().chars().take(300).collect::<String>());

    // --- pull with progress ---
    let pull_ev = collect(&app, "pull://progress");
    images::image_pull(h.clone(), h.state(), IMG.into()).await.expect("pull");
    assert!(!pull_ev.lock().unwrap().is_empty(), "no pull progress received");
    let il = images::images_list(h.state()).await.unwrap();
    let alp = il.iter().find(|i| i["repo"] == "alpine" && i["tag"] == "3.20").expect("alpine in the list");
    let det = images::image_history(h.state(), alp["id"].as_str().unwrap().into()).await.unwrap();
    println!("image arch: {}/{} layers={}", det["os"], det["architecture"], det["layers"].as_array().unwrap().len());

    // --- container lifecycle ---
    let name = format!("{PREFIX}-ctr");
    let spec: containers::CreateSpec = serde_json::from_value(serde_json::json!({
        "image": IMG, "name": name, "ports": ["18089:80"], "env": ["FOO=bar"], "binds": [format!("{PREFIX}-vol:/data")],
        "cmd": ["sh", "-c", "echo hello-from-smoke; echo oops-error >&2; while true; do sleep 1; done"],
        "restart": "no", "start": true
    }))
    .unwrap();
    let created = containers::container_create(h.state(), spec).await.expect("create");
    let id = created["id"].as_str().unwrap().to_string();

    // logs realtime
    let logs = collect(&app, &format!("logs://{id}"));
    containers::logs_subscribe(h.clone(), h.state(), id.clone(), Some(100), None).unwrap();
    assert!(wait_for(&logs, "hello-from-smoke", 10).await, "logs: {:?}", logs.lock().unwrap());
    assert!(wait_for(&logs, "oops-error", 5).await);
    let all = logs.lock().unwrap().join("\n");
    println!("sample log: {}", all.chars().take(300).collect::<String>());
    assert!(all.contains("stderr"), "stderr was not distinguished");
    assert!(all.contains("\"ts\":\"20"), "missing timestamp");

    // stats
    let sts = collect(&app, &format!("stats://{id}"));
    containers::stats_subscribe(h.clone(), h.state(), id.clone()).unwrap();
    assert!(wait_for(&sts, "memUsed", 10).await, "stats: {:?}", sts.lock().unwrap());
    println!("sample stats: {}", sts.lock().unwrap().last().unwrap());
    let one = containers::containers_stats(h.state(), vec![id.clone()]).await.unwrap();
    assert!(one.get(&id).is_some());
    containers::stats_unsubscribe(h.state(), id.clone());
    containers::logs_unsubscribe(h.state(), id.clone());

    // inspect + list reflect ports/mounts
    let ins = containers::container_inspect(h.state(), id.clone()).await.unwrap();
    assert_eq!(ins["HostConfig"]["RestartPolicy"]["Name"], "no");
    let cl = containers::containers_list(h.state()).await.unwrap();
    let me = cl.iter().find(|c| c["id"] == id.as_str()).unwrap();
    assert_eq!(me["state"], "running");
    assert!(me["ports"].as_array().unwrap().iter().any(|p| p["publicPort"] == 18089));
    assert!(me["mounts"].as_array().unwrap().iter().any(|m| m["name"] == format!("{PREFIX}-vol")));

    // terminal (exec) in both directions
    let sid = "smokesession000000000000000001".to_string();
    let ex = collect(&app, &format!("exec://{sid}"));
    let r = containers::exec_open(h.clone(), h.state(), sid.clone(), id.clone(), "auto".into(), 100, 30).await.expect("exec_open");
    println!("exec shell: {}", r["shell"]);
    containers::exec_resize(h.state(), sid.clone(), 120, 40).await.expect("resize");
    containers::exec_write(h.state(), sid.clone(), "echo $((6*7))-marker\n".into()).await.unwrap();
    let mut found = false;
    for _ in 0..80 {
        let text: String = ex
            .lock()
            .unwrap()
            .iter()
            .filter_map(|p| {
                let v: serde_json::Value = serde_json::from_str(p).ok()?;
                let b = base64::engine::general_purpose::STANDARD.decode(v["d"].as_str()?).ok()?;
                Some(String::from_utf8_lossy(&b).to_string())
            })
            .collect();
        if text.contains("42-marker") {
            found = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(found, "the terminal returned no output");
    containers::exec_close(h.state(), sid).await.unwrap();

    // network
    let net = format!("{PREFIX}-net");
    netvol::network_create(h.state(), serde_json::from_value(serde_json::json!({"name": net, "driver": "bridge", "subnet": "172.31.77.0/24"})).unwrap())
        .await
        .expect("net create");
    let nl = netvol::networks_list(h.state()).await.unwrap();
    let nrow = nl.iter().find(|n| n["name"] == net.as_str()).expect("net listed");
    assert_eq!(nrow["subnet"], "172.31.77.0/24");
    netvol::network_connect(h.state(), net.clone(), id.clone()).await.expect("connect");
    let nd = netvol::network_inspect(h.state(), nrow["id"].as_str().unwrap().into()).await.unwrap();
    assert_eq!(nd["containers"].as_array().unwrap().len(), 1);
    netvol::network_disconnect(h.state(), net.clone(), id.clone()).await.expect("disconnect");

    // volume: write data, then browse / download / backup / restore
    let vol = format!("{PREFIX}-vol");
    let mut w = crate::cli::docker_cmd(&st);
    w.args(["exec", &name, "sh", "-c", "mkdir -p /data/sub && echo data1 > /data/a.txt && echo data2 > /data/sub/b.txt"]);
    crate::cli::run_output(w).await.expect("write data");
    let files = netvol::volume_ls_files(h.state(), vol.clone(), None).await.expect("ls");
    println!("volume files: {:?}", files);
    assert!(files.iter().any(|f| f["name"] == "a.txt" && f["isDir"] == false));
    assert!(files.iter().any(|f| f["name"] == "sub" && f["isDir"] == true));
    let sub = netvol::volume_ls_files(h.state(), vol.clone(), Some("sub".into())).await.expect("ls sub");
    assert!(sub.iter().any(|f| f["name"] == "b.txt"));
    let dl = std::env::temp_dir().join("dockspan-smoke-dl.txt");
    netvol::volume_download_file(h.state(), vol.clone(), "a.txt".into(), dl.to_string_lossy().into()).await.expect("download");
    assert_eq!(std::fs::read_to_string(&dl).unwrap().trim(), "data1");
    let bk = netvol::volume_backup(h.state(), vol.clone()).await.expect("backup");
    println!("backup: {bk}");
    let bname = std::path::Path::new(&bk).file_name().unwrap().to_string_lossy().to_string();
    assert!(netvol::backups_list().iter().any(|b| b["name"] == bname.as_str()));
    let vol2 = format!("{PREFIX}-vol2");
    netvol::volume_create(h.state(), vol2.clone()).await.unwrap();
    netvol::volume_restore(h.state(), vol2.clone(), bname.clone()).await.expect("restore");
    let f2 = netvol::volume_ls_files(h.state(), vol2.clone(), None).await.unwrap();
    assert!(f2.iter().any(|f| f["name"] == "a.txt"), "restore: {:?}", f2);
    let dfv = prune::system_df(h.state()).await.unwrap();
    assert!(dfv["volumes"].as_array().unwrap().iter().any(|v| v["name"] == vol.as_str()));
    let _ = std::fs::remove_file(&bk);

    // stop / restart / remove
    containers::container_restart(h.state(), id.clone()).await.expect("restart");
    containers::container_stop(h.state(), id.clone()).await.expect("stop");
    for i in 0..4 {
        let cl = containers::containers_list(h.state()).await.unwrap();
        let c = cl.iter().find(|c| c["id"] == id.as_str()).unwrap();
        println!("sau stop +{i}s: state={} status={}", c["state"], c["status"]);
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let cl = containers::containers_list(h.state()).await.unwrap();
    assert_eq!(cl.iter().find(|c| c["id"] == id.as_str()).unwrap()["state"], "exited");
    containers::container_start(h.state(), id.clone()).await.expect("start");
    containers::container_remove(h.state(), id.clone(), true).await.expect("remove");
    netvol::network_remove(h.state(), nrow["id"].as_str().unwrap().into()).await.expect("net rm");
    netvol::volume_remove(h.state(), vol.clone()).await.expect("vol rm");
    netvol::volume_remove(h.state(), vol2.clone()).await.expect("vol2 rm");

    // engine errors are returned verbatim
    let e = containers::container_start(h.state(), "khong-ton-tai-xyz".into()).await.unwrap_err();
    println!("engine error: {e}");
    assert!(e.to_lowercase().contains("no such container"), "{e}");
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn compose_project_flow() {
    let app = mk_app();
    let h = app.handle().clone();
    let st = h.state::<AppState>();
    events::start_monitor(&h);
    wait_docker(&st).await;

    let dir = std::env::temp_dir().join(format!("{PREFIX}-proj"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("compose.yaml"),
        format!("services:\n  web:\n    image: {IMG}\n    command: sleep 300\n    ports:\n      - \"18090:80\"\n  worker:\n    image: {IMG}\n    command: sleep 300\n"),
    )
    .unwrap();
    std::fs::write(dir.join("Dockerfile"), format!("FROM {IMG}\nRUN echo built > /built.txt\n")).unwrap();
    std::fs::write(dir.join(".env"), "API_TOKEN=abc\n").unwrap();

    let sc = projects::project_scan(h.state(), dir.to_string_lossy().into()).await.expect("scan");
    println!(
        "scan: compose={:?} dockerfile={} project={} services={:?}",
        sc.compose_file,
        sc.has_dockerfile,
        sc.compose_project,
        sc.services.iter().map(|s| (&s.name, &s.ports)).collect::<Vec<_>>()
    );
    assert_eq!(sc.compose_file.as_deref(), Some("compose.yaml"));
    assert!(sc.has_dockerfile);
    assert_eq!(sc.services.len(), 2);
    assert!(sc.services.iter().any(|s| s.name == "web" && s.ports == vec!["18090→80".to_string()]));

    let p = projects::project_add(h.state(), projects::AddSpec { name: "smoke".into(), path: dir.to_string_lossy().into() }).await.expect("add");
    assert!(projects::project_add(h.state(), projects::AddSpec { name: "x".into(), path: dir.to_string_lossy().into() }).await.is_err());
    assert_eq!(projects::project_list(h.state()).len(), 1);

    let prog = collect(&app, "compose://progress");
    projects::compose_run(h.clone(), h.state(), p.id.clone(), "up".into()).await.expect("up");
    assert!(!prog.lock().unwrap().is_empty(), "no compose progress");
    let cl = containers::containers_list(h.state()).await.unwrap();
    let mine: Vec<_> = cl.iter().filter(|c| c["project"] == p.compose_project.as_str()).collect();
    println!("project containers: {:?}", mine.iter().map(|c| (c["name"].as_str().unwrap(), c["service"].as_str().unwrap(), c["state"].as_str().unwrap())).collect::<Vec<_>>());
    assert_eq!(mine.len(), 2);
    assert!(mine.iter().all(|c| c["state"] == "running"));

    projects::compose_run(h.clone(), h.state(), p.id.clone(), "restart".into()).await.expect("restart");
    projects::compose_run(h.clone(), h.state(), p.id.clone(), "stop".into()).await.expect("stop");
    let cl = containers::containers_list(h.state()).await.unwrap();
    assert!(cl.iter().filter(|c| c["project"] == p.compose_project.as_str()).all(|c| c["state"] == "exited"));

    // files: read/write and path traversal is blocked
    let files = projects::project_files(h.state(), p.id.clone()).unwrap();
    println!("files: {:?}", files);
    assert!(projects::project_read_file(h.state(), p.id.clone(), ".env".into()).unwrap().contains("API_TOKEN"));
    assert!(projects::project_read_file(h.state(), p.id.clone(), "../etc/passwd".into()).is_err());
    projects::project_write_file(h.state(), p.id.clone(), ".env".into(), "A=1\n".into()).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join(".env")).unwrap(), "A=1\n");

    // build image
    let build_ev = collect(&app, "build://log");
    images::image_build(h.clone(), h.state(), p.id.clone(), format!("{PREFIX}-img:test"), false).await.expect("build");
    assert!(build_ev.lock().unwrap().len() > 2);
    let il = images::images_list(h.state()).await.unwrap();
    assert!(il.iter().any(|i| i["repo"] == format!("{PREFIX}-img").as_str()));

    projects::compose_run(h.clone(), h.state(), p.id.clone(), "down".into()).await.expect("down");
    let cl = containers::containers_list(h.state()).await.unwrap();
    assert!(!cl.iter().any(|c| c["project"] == p.compose_project.as_str()));
    images::image_remove(h.state(), format!("{PREFIX}-img:test"), Some(true)).await.expect("rm img");
    projects::project_remove(h.state(), p.id.clone());
    assert!(projects::project_list(h.state()).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn schedule_next_due() {
    use chrono::{Datelike, Local, TimeZone, Timelike, Weekday};
    let after = Local.with_ymd_and_hms(2026, 10, 14, 10, 0, 0).unwrap(); // Wednesday
    let d = prune::next_due("daily", after);
    assert_eq!((d.day(), d.hour()), (15, 2));
    let w = prune::next_due("weekly", after);
    assert_eq!(w.weekday(), Weekday::Sun);
    assert_eq!((w.day(), w.month(), w.hour()), (18, 10, 2));
    let m = prune::next_due("monthly", after);
    assert_eq!((m.day(), m.month()), (1, 11));
    // exactly 02:00 on a Sunday just ran, so the next run is the following week
    let sun = Local.with_ymd_and_hms(2026, 10, 18, 2, 0, 0).unwrap();
    assert_eq!(prune::next_due("weekly", sun).day(), 25);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn exec_resize_probe() {
    let app = mk_app();
    let h = app.handle().clone();
    let st = h.state::<AppState>();
    events::start_monitor(&h);
    wait_docker(&st).await;
    let name = format!("{PREFIX}-probe");
    let spec: containers::CreateSpec = serde_json::from_value(serde_json::json!({
        "image": IMG, "name": name, "cmd": ["sleep", "120"], "restart": "no", "start": true
    })).unwrap();
    let id = containers::container_create(h.state(), spec).await.unwrap()["id"].as_str().unwrap().to_string();
    for shell in ["sh", "bash"] {
        let sid = format!("probe-{shell}");
        let r = containers::exec_open(h.clone(), h.state(), sid.clone(), id.clone(), shell.into(), 80, 24).await;
        println!("{shell}: open={:?}", r.as_ref().map(|v| v["shell"].clone()));
        if r.is_err() { continue; }
        for i in 0..6 {
            let res = containers::exec_resize(h.state(), sid.clone(), 100 + i, 30).await;
            println!("{shell}: resize #{i} => {:?}", res);
            if i == 2 { containers::exec_write(h.state(), sid.clone(), "echo hi\n".into()).await.unwrap(); }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        containers::exec_close(h.state(), sid).await.unwrap();
    }
    containers::container_remove(h.state(), id, true).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn stop_probe() {
    let app = mk_app();
    let h = app.handle().clone();
    let st = h.state::<AppState>();
    events::start_monitor(&h);
    wait_docker(&st).await;
    let name = format!("{PREFIX}-stopprobe");
    let spec: containers::CreateSpec = serde_json::from_value(serde_json::json!({
        "image": IMG, "name": name, "cmd": ["sh", "-c", "while true; do sleep 1; done"], "restart": "no", "start": true
    })).unwrap();
    let id = containers::container_create(h.state(), spec).await.unwrap()["id"].as_str().unwrap().to_string();
    let state_of = |cl: Vec<serde_json::Value>| cl.iter().find(|c| c["id"] == id.as_str()).map(|c| c["state"].as_str().unwrap().to_string());
    let t0 = std::time::Instant::now();
    println!("t={:?} start state={:?}", t0.elapsed(), state_of(containers::containers_list(h.state()).await.unwrap()));
    containers::container_restart(h.state(), id.clone()).await.unwrap();
    println!("t={:?} after restart state={:?}", t0.elapsed(), state_of(containers::containers_list(h.state()).await.unwrap()));
    containers::container_stop(h.state(), id.clone()).await.unwrap();
    println!("t={:?} after stop state={:?}", t0.elapsed(), state_of(containers::containers_list(h.state()).await.unwrap()));
    tokio::time::sleep(Duration::from_secs(2)).await;
    println!("t={:?} +2s state={:?}", t0.elapsed(), state_of(containers::containers_list(h.state()).await.unwrap()));
    containers::container_remove(h.state(), id, true).await.unwrap();
}

// ---------------------------------------------------------------- Kubernetes

fn mk_k8s_app() -> App<MockRuntime> {
    let app = mk_app();
    app.manage(crate::k8s::K8sState::default());
    app
}

/// READ-ONLY probe of a real cluster: version, namespaces, lists and a pod log (no follow).
/// Uses `$DOCKSPAN_K8S_CONTEXT`, otherwise the kubeconfig current context. Never writes anything.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn k8s_read_probe() {
    use crate::k8s;
    let app = mk_k8s_app();
    let h = app.handle().clone();
    let all = k8s::k8s_clusters(h.state());
    println!("clusters: {}", all["clusters"].as_array().unwrap().len());
    let id = std::env::var("DOCKSPAN_K8S_CONTEXT").ok().unwrap_or_else(|| all["activeId"].as_str().unwrap().to_string());
    let info = k8s::k8s_test(h.state(), h.state(), id.clone(), None).await.expect("k8s_test");
    println!("test: {}", info);
    let ns = k8s::k8s_namespaces(h.state(), h.state(), id.clone()).await.expect("namespaces");
    println!("namespaces: {:?}", ns);
    for kind in ["deployments", "pods", "services"] {
        let rows = k8s::k8s_list(h.state(), h.state(), id.clone(), kind.into(), None).await.expect(kind);
        println!("{}: {}", kind, rows.len());
        if let Some(r) = rows.first() {
            println!("  first: {}", r);
        }
    }
    let pods = k8s::k8s_list(h.state(), h.state(), id.clone(), "pods".into(), None).await.unwrap();
    if let Some(p) = pods.iter().find(|p| p["status"] == "Running") {
        let buf = collect(&app, "k8s://logs/probe");
        k8s::k8s_logs(h.clone(), h.state(), h.state(), "probe".into(), id.clone(), p["namespace"].as_str().unwrap().into(), p["name"].as_str().unwrap().into(), None, false, false, Some(5))
            .await
            .expect("logs");
        assert!(wait_for(&buf, "\"end\"", 15).await, "log stream did not end");
        println!("log batches: {}", buf.lock().unwrap().len());
    }
    // Watch opens without error and is cancelled again.
    k8s::k8s_watch(h.clone(), h.state(), h.state(), id.clone(), None).await.expect("watch");
    tokio::time::sleep(Duration::from_secs(2)).await;
    k8s::k8s_unwatch(h.state());
}

/// Write flow against a THROWAWAY cluster: scale, rollout restart, delete pod, logs, exec, port-forward, watch.
/// Refuses to run unless the context name contains `dockspan-smoke`, e.g.
/// `kind create cluster --name dockspan-smoke --kubeconfig /tmp/ds.kubeconfig` then
/// `DOCKSPAN_K8S_KUBECONFIG=/tmp/ds.kubeconfig DOCKSPAN_K8S_CONTEXT=kind-dockspan-smoke cargo test k8s_write_flow -- --ignored --nocapture`.
/// Everything lives in namespace `dockspan-smoke`, deleted at the end (alpine has no busybox httpd, so the pod uses `busybox:1.36`).
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn k8s_write_flow() {
    use crate::k8s;
    use k8s_openapi::api::apps::v1::Deployment;
    use k8s_openapi::api::core::v1::{Namespace, Service};
    use kube::api::{Api, DeleteParams, PostParams};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let path = std::env::var("DOCKSPAN_K8S_KUBECONFIG").expect("set DOCKSPAN_K8S_KUBECONFIG");
    let ctx = std::env::var("DOCKSPAN_K8S_CONTEXT").expect("set DOCKSPAN_K8S_CONTEXT");
    assert!(ctx.contains(PREFIX), "refusing to write to a cluster whose context is not named *{}*", PREFIX);
    let ns = PREFIX.to_string();
    let app = mk_k8s_app();
    let h = app.handle().clone();
    let st: tauri::State<'_, AppState> = h.state();
    let ks: tauri::State<'_, k8s::K8sState> = h.state();

    let c = k8s::k8s_add(h.state(), path.clone(), ctx.clone()).expect("add");
    let id = c.id.clone();
    println!("test: {}", k8s::k8s_test(h.state(), h.state(), id.clone(), None).await.expect("test"));

    // Fixtures through kube directly: a namespace, a 1-replica busybox httpd deployment and a service on a named port.
    let kc = kube::config::Kubeconfig::read_from(&path).unwrap();
    let cfg = kube::Config::from_custom_kubeconfig(kc, &kube::config::KubeConfigOptions { context: Some(ctx.clone()), ..Default::default() }).await.unwrap();
    let client = kube::Client::try_from(cfg).unwrap();
    let pp = PostParams::default();
    let _ = Api::<Namespace>::all(client.clone()).create(&pp, &serde_json::from_value(serde_json::json!({ "metadata": { "name": ns } })).unwrap()).await;
    let dep: Deployment = serde_json::from_value(serde_json::json!({
        "metadata": { "name": "web" },
        "spec": { "replicas": 1, "selector": { "matchLabels": { "app": "web" } }, "template": {
            "metadata": { "labels": { "app": "web" } },
            "spec": { "terminationGracePeriodSeconds": 1, "containers": [{ "name": "web", "image": "busybox:1.36",
                "command": ["sh", "-c", "mkdir -p /w && echo dockspan-ok > /w/index.html && echo started && httpd -f -p 8080 -h /w"],
                "ports": [{ "name": "http", "containerPort": 8080 }],
                "readinessProbe": { "tcpSocket": { "port": 8080 }, "periodSeconds": 1 } }] } } }
    })).unwrap();
    Api::<Deployment>::namespaced(client.clone(), &ns).create(&pp, &dep).await.expect("create deployment");
    let svc: Service = serde_json::from_value(serde_json::json!({
        "metadata": { "name": "web" }, "spec": { "selector": { "app": "web" }, "ports": [{ "port": 80, "targetPort": "http" }] }
    })).unwrap();
    Api::<Service>::namespaced(client.clone(), &ns).create(&pp, &svc).await.expect("create service");

    let list = |kind: &'static str| {
        let h = h.clone();
        let id = id.clone();
        let ns = ns.clone();
        async move { k8s::k8s_list(h.state(), h.state(), id, kind.into(), Some(ns)).await.unwrap() }
    };
    async fn until<F: std::future::Future<Output = bool>>(secs: u64, mut f: impl FnMut() -> F) -> bool {
        for _ in 0..secs * 2 {
            if f().await {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        false
    }
    assert!(until(120, || async { list("deployments").await.first().is_some_and(|d| d["ready"] == 1) }).await, "deployment never became ready");

    let watched = collect(&app, "k8s://watch");
    k8s::k8s_watch(h.clone(), h.state(), h.state(), id.clone(), Some(ns.clone())).await.expect("watch");
    tokio::time::sleep(Duration::from_secs(1)).await;

    k8s::k8s_scale(h.state(), h.state(), id.clone(), ns.clone(), "web".into(), 2).await.expect("scale");
    assert!(until(90, || async { list("deployments").await[0]["ready"] == 2 }).await, "scale to 2 never became ready");
    assert!(wait_for(&watched, "\"deployments\"", 5).await, "no watch event for deployments");
    println!("scaled to 2, watch events: {}", watched.lock().unwrap().len());

    k8s::k8s_restart(h.state(), h.state(), id.clone(), ns.clone(), "web".into()).await.expect("restart");
    let d = Api::<Deployment>::namespaced(client.clone(), &ns).get("web").await.unwrap();
    assert!(d.spec.unwrap().template.metadata.unwrap().annotations.unwrap().contains_key("kubectl.kubernetes.io/restartedAt"));
    assert!(until(120, || async {
        let d = list("deployments").await;
        let p = list("pods").await;
        d[0]["updated"] == 2 && d[0]["ready"] == 2 && p.iter().filter(|x| x["status"] == "Running").count() == 2 && p.len() == 2
    })
    .await, "rollout restart did not finish");

    let victim = list("pods").await[0]["name"].as_str().unwrap().to_string();
    k8s::k8s_delete_pod(h.state(), h.state(), id.clone(), ns.clone(), victim.clone()).await.expect("delete pod");
    assert!(until(90, || async { let p = list("pods").await; !p.iter().any(|x| x["name"] == victim.as_str()) && p.iter().filter(|x| x["ready"] == "1/1").count() == 2 }).await, "replacement pod missing");
    let pod = list("pods").await.iter().find(|x| x["ready"] == "1/1").unwrap()["name"].as_str().unwrap().to_string();

    // logs (no follow) end with {end: true}
    let logs = collect(&app, "k8s://logs/wf");
    k8s::k8s_logs(h.clone(), h.state(), h.state(), "wf".into(), id.clone(), ns.clone(), pod.clone(), None, false, false, Some(50)).await.expect("logs");
    assert!(wait_for(&logs, "started", 10).await, "log line missing");
    assert!(wait_for(&logs, "\"end\"", 10).await);

    // exec: auto shell, run a command, read the output back
    let out = collect(&app, "exec://wf");
    k8s::k8s_exec(h.clone(), h.state(), h.state(), "wf".into(), id.clone(), ns.clone(), pod.clone(), None, "auto".into(), 100, 30).await.expect("exec");
    k8s::k8s_exec_resize(h.state(), "wf".into(), 120, 40).await.expect("resize");
    k8s::k8s_exec_write(h.state(), "wf".into(), "echo dockspan-$((40+2))\n".into()).await.expect("write");
    let decoded = || {
        let b64 = base64::engine::general_purpose::STANDARD;
        out.lock().unwrap().iter().filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok()).filter_map(|v| v["d"].as_str().and_then(|d| b64.decode(d).ok())).map(|b| String::from_utf8_lossy(&b).to_string()).collect::<String>()
    };
    let mut ok = false;
    for _ in 0..50 {
        if decoded().contains("dockspan-42") {
            ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(ok, "exec output missing: {:?}", decoded());
    k8s::k8s_exec_write(h.state(), "wf".into(), "exit\n".into()).await.expect("exit");
    assert!(wait_for(&out, "close", 10).await, "exec did not close after exit");
    k8s::k8s_exec_close(h.state(), "wf".into()).await.unwrap();

    // port-forward svc/web:80 → named target port http (8080); privileged port gets +8000
    let pf = k8s::k8s_pf_start(h.state(), h.state(), id.clone(), ns.clone(), "web".into(), 80, None).await.expect("pf start");
    println!("forward: {:?}", pf);
    assert!(pf.local_port >= 8080);
    for round in 0..2 {
        let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", pf.local_port)).await.expect("connect local");
        sock.write_all(b"GET / HTTP/1.0\r\nHost: x\r\n\r\n").await.unwrap();
        let mut body = String::new();
        let _ = tokio::time::timeout(Duration::from_secs(10), sock.read_to_string(&mut body)).await;
        assert!(body.contains("dockspan-ok"), "round {}: bad response {:?}", round, body);
    }
    assert_eq!(k8s::k8s_pf_list(h.state()).len(), 1);

    // remove the cluster: its port-forwards stop and the port is free again
    k8s::k8s_unwatch(h.state());
    k8s::k8s_remove(h.state(), h.state(), id.clone()).await.expect("remove");
    assert!(k8s::k8s_pf_list(h.state()).is_empty());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(tokio::net::TcpListener::bind(("127.0.0.1", pf.local_port)).await.is_ok(), "local port still bound after remove");
    let _ = (st, ks);

    Api::<Namespace>::all(client).delete(&ns, &DeleteParams::default()).await.expect("delete namespace");
    println!("k8s write flow OK");
}

// ---------------------------------------------------------------- SSH / TCP+TLS / WSL2

/// Add, test, switch to, use and remove SSH / TCP+TLS / WSL2 connections. Each one runs only when its variables are set:
/// `DOCKSPAN_SSH` (`user@host:port`) + optional `DOCKSPAN_SSH_KEY`; `DOCKSPAN_TLS` (`host:port`) + `DOCKSPAN_TLS_CERTS` (folder with
/// ca.pem, cert.pem, key.pem); `DOCKSPAN_WSL` (distro). Uses a temporary DOCKER_CONFIG, so `~/.docker` is not touched.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn multi_engine_flow() {
    use crate::ctx::{self, NewCtx};
    let cfg = std::env::temp_dir().join("dockspan-smoke-docker-config");
    let _ = std::fs::remove_dir_all(&cfg);
    std::fs::create_dir_all(&cfg).unwrap();
    std::env::set_var("DOCKER_CONFIG", &cfg);
    let app = mk_app();
    let h = app.handle().clone();
    let mut forms: Vec<NewCtx> = Vec::new();
    if let Ok(v) = std::env::var("DOCKSPAN_SSH") {
        let (dest, port) = v.rsplit_once(':').map(|(a, b)| (a.to_string(), b.parse().ok())).unwrap_or((v.clone(), None));
        let (user, host) = dest.split_once('@').map(|(u, h)| (Some(u.to_string()), h.to_string())).unwrap_or((None, dest.clone()));
        forms.push(NewCtx { name: format!("{}-ssh", PREFIX), kind: "ssh".into(), host: Some(host), user, port, key: std::env::var("DOCKSPAN_SSH_KEY").ok(), ..Default::default() });
    }
    if let Ok(v) = std::env::var("DOCKSPAN_TLS") {
        forms.push(NewCtx { name: format!("{}-tls", PREFIX), kind: "tcp".into(), host: Some(v), tls: Some(true), cert_dir: std::env::var("DOCKSPAN_TLS_CERTS").ok(), ..Default::default() });
    }
    if let Ok(v) = std::env::var("DOCKSPAN_WSL") {
        forms.push(NewCtx { name: format!("{}-wsl", PREFIX), kind: "wsl".into(), distro: Some(v), ..Default::default() });
    }
    assert!(!forms.is_empty(), "set DOCKSPAN_SSH, DOCKSPAN_TLS and/or DOCKSPAN_WSL");

    for f in forms {
        let name = f.name.clone();
        let kind = f.kind.clone();
        println!("--- {} ({})", name, kind);
        let probe = ctx::ctx_probe(NewCtx { ..clone_form(&f) }).await.unwrap_or_else(|e| panic!("{}: probe failed: {}", name, e));
        println!("probe: Docker {} · {} · {} ms", probe["version"], probe["os"], probe["latencyMs"]);
        let added = ctx::ctx_add(h.state(), f).expect("add");
        assert!(added.supported, "{:?}", added.reason);
        assert!(ctx::ctx_add(h.state(), NewCtx { name: name.clone(), kind: "wsl".into(), distro: Some("x".into()), ..Default::default() }).is_err(), "duplicate name accepted");
        if kind != "wsl" {
            // Written exactly like `docker context create`: the real CLI must list it with the same endpoint.
            let out = std::process::Command::new("docker").env("DOCKER_CONFIG", &cfg).args(["context", "inspect", &name, "--format", "{{.Endpoints.docker.Host}}"]).output().unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), added.endpoint, "docker CLI sees: {}", String::from_utf8_lossy(&out.stderr));
        }
        let t = ctx::ctx_test(h.state(), added.id.clone()).await.expect("test");
        println!("test: Docker {} · {} ms", t["version"], t["latencyMs"]);

        let sw = ctx::ctx_switch(h.clone(), h.state(), added.id.clone()).await.expect("switch");
        assert_eq!(sw.id, added.id);
        let st = h.state::<AppState>();
        let n = containers::containers_list(h.state()).await.expect("containers").len();
        let df = prune::system_df(h.state()).await.expect("df");
        let status = events::engine_status(h.state()).await.expect("status");
        assert_eq!(status["state"], "on");
        // The docker CLI (compose/build/volume helpers) reaches the same engine.
        let out = crate::cli::run_output({
            let mut c = crate::cli::docker_cmd(&st);
            c.args(["version", "--format", "{{.Server.Version}}"]);
            c
        })
        .await
        .expect("docker CLI through the context");
        assert_eq!(out.trim(), t["version"].as_str().unwrap());
        // A terminal session works over the connection too (hijacked HTTP through the bridge / TLS).
        let ex = collect(&app, "exec://mesid");
        let cid = {
            let d = st.docker().unwrap();
            let _ = d.remove_container(&format!("{}-me", PREFIX), Some(bollard::query_parameters::RemoveContainerOptionsBuilder::new().force(true).build())).await;
            let mut c = crate::cli::docker_cmd(&st);
            c.args(["run", "-d", "--name", &format!("{}-me", PREFIX), IMG, "sleep", "300"]);
            crate::cli::run_output(c).await.expect("docker run").trim().to_string()
        };
        containers::exec_open(h.clone(), h.state(), "mesid".into(), cid.clone(), "sh".into(), 80, 24).await.expect("exec");
        containers::exec_write(h.state(), "mesid".into(), "echo multi-$((6*7))\n".into()).await.unwrap();
        let mut ok = false;
        for _ in 0..50 {
            let b64 = base64::engine::general_purpose::STANDARD;
            let txt: String = ex.lock().unwrap().iter().filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok()).filter_map(|v| v["d"].as_str().and_then(|d| b64.decode(d).ok())).map(|b| String::from_utf8_lossy(&b).to_string()).collect();
            if txt.contains("multi-42") {
                ok = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        assert!(ok, "exec output missing");
        containers::exec_close(h.state(), "mesid".into()).await.unwrap();
        containers::container_remove(h.state(), cid, true).await.expect("rm");
        println!("{}: {} containers, images {} B", name, n, df["imagesSize"]);

        assert!(ctx::ctx_remove(h.state(), added.id.clone()).is_err(), "removing the active context must be refused");
        ctx::ctx_switch(h.clone(), h.state(), "default".into()).await.expect("switch back");
        assert!(st.bridge.lock().unwrap().is_none(), "bridge of the old context still running");
        ctx::ctx_remove(h.state(), added.id.clone()).expect("remove");
        assert!(!ctx::ctx_list(h.state()).iter().any(|c| c["id"] == added.id.as_str()));
    }
    let _ = std::fs::remove_dir_all(&cfg);
}

fn clone_form(f: &crate::ctx::NewCtx) -> crate::ctx::NewCtx {
    crate::ctx::NewCtx {
        name: f.name.clone(), kind: f.kind.clone(), socket: f.socket.clone(), host: f.host.clone(), user: f.user.clone(),
        port: f.port, key: f.key.clone(), tls: f.tls, cert_dir: f.cert_dir.clone(), distro: f.distro.clone(),
    }
}

/// READ-ONLY: list WSL2 distros and the Docker version inside the running ones (Windows, or WSL with interop).
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn wsl_list_probe() {
    let app = mk_app();
    let h = app.handle().clone();
    let r = crate::wsl::wsl_list(h.state()).await.expect("wsl_list");
    println!("{}", serde_json::to_string_pretty(&r).unwrap());
}

/// READ-ONLY: hosts of the real `~/.ssh/config` as the Add connection modal shows them.
#[tokio::test]
#[ignore]
async fn ssh_hosts_probe() {
    for h in crate::sshcfg::ssh_hosts().await {
        println!("{} → user:{} port:{} key:{} jump:{}", h.alias, h.user.is_some(), h.port, h.identity_file.is_some(), h.proxy_jump.is_some());
    }
}

/// Interactive SSH terminal in a real PTY: host-key question answered in the terminal, a command, a resize seen by the
/// remote shell, two sessions at once, and `exit` closing the session. Needs `DOCKSPAN_SSH` (`user@host:port`) +
/// `DOCKSPAN_SSH_KEY`; when the host is not in known_hosts yet the test answers "yes" (remove it afterwards with ssh-keygen -R).
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn ssh_terminal_flow() {
    use crate::sshterm::{self, SshTarget};
    let v = std::env::var("DOCKSPAN_SSH").expect("set DOCKSPAN_SSH");
    let (dest, port) = v.rsplit_once(':').map(|(a, b)| (a.to_string(), b.parse().ok())).unwrap();
    let (user, host) = dest.split_once('@').map(|(u, h)| (Some(u.to_string()), h.to_string())).unwrap();
    let target = SshTarget { host, user, port, key: std::env::var("DOCKSPAN_SSH_KEY").ok() };
    let app = mk_app();
    app.manage(sshterm::SshState::default());
    let h = app.handle().clone();
    let text = |buf: &Arc<StdMutex<Vec<String>>>| -> String {
        let b64 = base64::engine::general_purpose::STANDARD;
        buf.lock().unwrap().iter().filter_map(|p| serde_json::from_str::<serde_json::Value>(p).ok()).filter_map(|v| v["d"].as_str().and_then(|d| b64.decode(d).ok())).map(|b| String::from_utf8_lossy(&b).to_string()).collect()
    };
    async fn until(f: impl Fn() -> bool, secs: u64) -> bool {
        for _ in 0..secs * 10 {
            if f() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    }
    let a = collect(&app, "exec://ssha");
    sshterm::ssh_open(h.clone(), h.state(), "ssha".into(), target.clone(), 100, 30).expect("open");
    // Either the host-key question (answered in the terminal, like a user would) or a shell prompt.
    assert!(until(|| { let t = text(&a); t.contains("continue connecting") || t.contains('#') || t.contains('$') }, 15).await, "no prompt: {:?}", text(&a));
    if text(&a).contains("continue connecting") {
        sshterm::ssh_write(h.state(), "ssha".into(), "yes\n".into()).unwrap();
        assert!(until(|| text(&a).contains('#'), 15).await, "no shell after yes: {:?}", text(&a));
    }
    sshterm::ssh_write(h.state(), "ssha".into(), "echo pty-$((6*7)); stty size\n".into()).unwrap();
    assert!(until(|| text(&a).contains("pty-42") && text(&a).contains("30 100"), 10).await, "{:?}", text(&a));
    sshterm::ssh_resize(h.state(), "ssha".into(), 132, 41).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    sshterm::ssh_write(h.state(), "ssha".into(), "stty size\n".into()).unwrap();
    assert!(until(|| text(&a).contains("41 132"), 10).await, "resize not seen: {:?}", text(&a));

    // A second session at the same time.
    let b = collect(&app, "exec://sshb");
    sshterm::ssh_open(h.clone(), h.state(), "sshb".into(), target.clone(), 80, 24).expect("open b");
    assert!(until(|| text(&b).contains('#'), 15).await, "{:?}", text(&b));
    sshterm::ssh_write(h.state(), "sshb".into(), "echo second-$((1+1))\n".into()).unwrap();
    assert!(until(|| text(&b).contains("second-2"), 10).await);
    assert!(!text(&a).contains("second-2"), "output leaked between sessions");

    // `exit` ends a session by itself; ssh_close kills the other one.
    sshterm::ssh_write(h.state(), "ssha".into(), "exit\n".into()).unwrap();
    assert!(wait_for(&a, "\"close\"", 10).await, "no close after exit");
    assert!(sshterm::ssh_write(h.state(), "ssha".into(), "x".into()).is_err(), "session still open after exit");
    sshterm::ssh_close(h.state(), "sshb".into());
    assert!(wait_for(&b, "\"close\"", 10).await, "no close after ssh_close");

    // Wrong port: the ssh error is shown in the terminal and the session closes with a non-zero code.
    let c = collect(&app, "exec://sshc");
    sshterm::ssh_open(h.clone(), h.state(), "sshc".into(), SshTarget { port: Some(1), ..target }, 80, 24).expect("open c");
    assert!(wait_for(&c, "\"close\"", 15).await);
    assert!(text(&c).contains("refused"), "{:?}", text(&c));
    println!("ssh terminal flow OK");
}
