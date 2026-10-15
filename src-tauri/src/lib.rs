mod bridge;
mod cli;
mod containers;
mod ctx;
mod events;
mod images;
mod k8s;
mod netvol;
mod projects;
mod rawapi;
mod prune;
mod sshcfg;
mod state;
mod store;
mod util;
mod wsl;

#[cfg(test)]
mod smoke;

use state::AppState;
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use tauri::Manager;

pub fn run() {
    // GUI apps do not inherit the shell PATH; kubeconfig exec plugins (gke-gcloud-auth-plugin, aws, kubelogin…)
    // are started by kube-rs with the process PATH, so extend it before any thread is spawned.
    std::env::set_var("PATH", util::cli_path());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("cannot determine the app data directory");
            let store = store::Store::load(dir.join("store.json"));
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
            app.manage(k8s::K8sState::default());
            events::start_monitor(app.handle());
            prune::start_scheduler(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ctx::ctx_list, ctx::ctx_test, ctx::ctx_switch, ctx::ctx_probe, ctx::ctx_add, ctx::ctx_remove,
            wsl::wsl_list, wsl::wsl_install_docker, sshcfg::ssh_hosts,
            events::engine_status, events::engine_start, events::engine_stop,
            containers::containers_list, containers::container_start, containers::container_stop,
            containers::container_restart, containers::container_remove, containers::container_create,
            containers::container_inspect, containers::containers_stats,
            containers::stats_subscribe, containers::stats_unsubscribe,
            containers::logs_subscribe, containers::logs_unsubscribe,
            containers::exec_open, containers::exec_write, containers::exec_resize, containers::exec_close,
            images::images_list, images::image_pull, images::image_history, images::image_remove, images::image_build,
            netvol::networks_list, netvol::network_inspect, netvol::network_create, netvol::network_remove,
            netvol::network_connect, netvol::network_disconnect,
            netvol::volumes_list, netvol::volume_create, netvol::volume_remove, netvol::volume_ls_files,
            netvol::volume_download_file, netvol::volume_backup, netvol::volume_restore, netvol::backups_list,
            prune::system_df, prune::prune_run, prune::schedule_get, prune::schedule_set,
            projects::project_scan, projects::discover_projects, projects::project_list, projects::project_add,
            projects::project_remove, projects::project_rename, projects::project_refresh, projects::compose_run, projects::project_files,
            projects::project_read_file, projects::project_write_file, projects::open_in_editor,
            projects::open_terminal, projects::open_folder, projects::open_url, projects::save_text, projects::settings_get, projects::settings_set,
            k8s::k8s_clusters, k8s::k8s_kubeconfig_contexts, k8s::k8s_add, k8s::k8s_remove, k8s::k8s_select, k8s::k8s_test, k8s::k8s_probe,
            k8s::k8s_namespaces, k8s::k8s_list, k8s::k8s_scale, k8s::k8s_restart, k8s::k8s_delete_pod,
            k8s::k8s_watch, k8s::k8s_unwatch, k8s::k8s_logs, k8s::k8s_logs_stop,
            k8s::k8s_exec, k8s::k8s_exec_write, k8s::k8s_exec_resize, k8s::k8s_exec_close,
            k8s::k8s_pf_start, k8s::k8s_pf_stop, k8s::k8s_pf_list,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Dockspan");
}
