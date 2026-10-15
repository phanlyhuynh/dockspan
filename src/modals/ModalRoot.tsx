import { useApp } from '../store';
import { ConfirmModal, InfoModal, PaletteModal, PruneConfirmModal, ScheduleModal } from './Basic';
import { AddModal, BuildModal, FilesModal, RenameModal } from './Project';
import { ImageDrawer, NetCreateModal, NetDrawer, PullModal, RunModal, VolCreateModal, VolDrawer } from './Docker';

export function ModalRoot() {
  const m = useApp((s) => s.modal);
  if (!m) return null;
  switch (m.kind) {
    case 'confirm': return <ConfirmModal m={m} />;
    case 'info': return <InfoModal title={m.title} body={m.body} />;
    case 'palette': return <PaletteModal />;
    case 'add': return <AddModal path={m.path} />;
    case 'files': return <FilesModal projectId={m.projectId} />;
    case 'rename': return <RenameModal projectId={m.projectId} />;
    case 'run': return <RunModal image={m.image} />;
    case 'pull': return <PullModal />;
    case 'build': return <BuildModal projectId={m.projectId} />;
    case 'image': return <ImageDrawer imageRef={m.ref} />;
    case 'netCreate': return <NetCreateModal />;
    case 'net': return <NetDrawer id={m.id} />;
    case 'volCreate': return <VolCreateModal />;
    case 'vol': return <VolDrawer name={m.name} />;
    case 'pruneConfirm': return <PruneConfirmModal />;
    case 'schedule': return <ScheduleModal />;
  }
}
