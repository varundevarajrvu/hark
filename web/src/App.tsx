import { useEffect } from 'react';
import { Shell, Splash } from './components/shell.tsx';
import { ThreadView } from './components/thread.tsx';
import { Empty } from './components/ui.tsx';
import { AuthPage } from './pages/Auth.tsx';
import { HomePage } from './pages/Home.tsx';
import { MemoryPage } from './pages/Memory.tsx';
import { ProjectPage } from './pages/Project.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { SpecialtiesPage } from './pages/Specialties.tsx';
import { TasksPage } from './pages/Tasks.tsx';
import { VaultPage } from './pages/Vault.tsx';
import { useRoute, type Route } from './router.ts';
import { useStore } from './store.ts';

const TITLES: Record<Route['name'], string> = {
  home: 'Home',
  chat: 'Chat',
  project: 'Project',
  thread: 'Run',
  tasks: 'Scheduled tasks',
  memory: 'Memory',
  vault: 'Vault',
  specialties: 'Specialties',
  settings: 'Settings',
  notfound: 'Not found',
};

function Page({ route }: { route: Route }) {
  const mainThreadId = useStore((s) => s.mainThreadId);
  switch (route.name) {
    case 'home':
      return <HomePage />;
    case 'chat':
      return mainThreadId ? <ThreadView key={mainThreadId} threadId={mainThreadId} /> : null;
    case 'project':
      return <ProjectPage key={route.id} projectId={route.id} />;
    case 'thread':
      return (
        <ThreadView
          key={route.id}
          threadId={route.id}
          strip={<span className="label">Run · started by a task or an action</span>}
          emptyTitle="Nothing yet."
          emptyBody="This run has not written anything. You can talk to it directly."
        />
      );
    case 'tasks':
      return <TasksPage />;
    case 'memory':
      return <MemoryPage />;
    case 'vault':
      return <VaultPage />;
    case 'specialties':
      return <SpecialtiesPage />;
    case 'settings':
      return <SettingsPage />;
    case 'notfound':
      return (
        <div className="page">
          <Empty icon="info" title="There is nothing at this address.">
            <p>
              <a href="#/">Go to Home</a>
            </p>
          </Empty>
        </div>
      );
  }
}

export function App() {
  const auth = useStore((s) => s.auth);
  const route = useRoute();

  useEffect(() => {
    document.title = auth === 'in' ? `${TITLES[route.name]} · Vector` : 'Vector';
  }, [auth, route.name]);

  if (auth === 'loading') return <Splash />;
  if (auth === 'out') return <AuthPage />;
  return (
    <Shell route={route}>
      <Page route={route} />
    </Shell>
  );
}
