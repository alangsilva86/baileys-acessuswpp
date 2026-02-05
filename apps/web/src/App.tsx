import DashboardPage from './features/dashboard/DashboardPage';
import PipedriveInboxPage from './features/pipedrive/PipedriveInboxPage';

export default function App() {
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/ui/pipedrive')) {
    return <PipedriveInboxPage />;
  }
  return <DashboardPage />;
}
