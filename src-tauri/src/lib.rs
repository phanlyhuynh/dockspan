mod cli;
mod containers;
mod ctx;
mod events;
mod images;
mod netvol;
mod projects;
mod rawapi;
mod prune;
mod state;
mod store;
mod util;

#[cfg(test)]
mod smoke;

use state::AppState;
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("cannot determine the app data directory");
            let store = store::Store::load(dir.join("store.json"));
            let active = ctx::initial_context(store.settings.active_context_id.clone());
            app.manage(AppState {
                docker: StdMutex::new(None),
                active: StdMutex::new(active),
                info: StdMutex::new(None),
                tasks: StdMutex::new(HashMap::new()),
                execs: tokio::sync::Mutex::new(HashMap::new()),
                store: StdMutex::new(store),
            });
            events::start_monitor(app.handle());
            prune::start_scheduler(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ctx::ctx_list, ctx::ctx_test, ctx::ctx_switch,
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
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Dockspan");
}
