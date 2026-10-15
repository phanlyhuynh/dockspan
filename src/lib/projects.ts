import type { Container, Project } from '../api';
import { t } from '../i18n';

export interface ProjectStatus {
  up: number;
  total: number;
  hasCompose: boolean;
  label: string;
  pillCls: string;
  svcs: { name: string; state: Container['state'] | null }[];
}

/**
 * Project status computed from containers carrying the `com.docker.compose.project` label
 * over the number of services declared in the compose file.
 */
export function projectStatus(p: Project, containers: Container[]): ProjectStatus {
  const mine = containers.filter((c) => c.project === p.composeProject);
  const hasCompose = p.services.length > 0;
  const total = p.services.length;
  const svcs = p.services.map((sv) => {
    const c = mine.find((x) => x.service === sv.name);
    return { name: sv.name, state: c ? c.state : null };
  });
  const up = svcs.filter((s) => s.state === 'running').length;
  let label: string;
  let pillCls = 'pill';
  if (!hasCompose) label = 'Dockerfile';
  else if (up === 0) label = t("Stopped");
  else if (up === total) { label = t("Running"); pillCls = 'pill run'; }
  else { label = t("Partial {up}/{total}", { up, total }); pillCls = 'pill part'; }
  return { up, total, hasCompose, label, pillCls, svcs };
}
