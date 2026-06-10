import Dashboard from './Dashboard';
import Search from './Search';

export default function App() {
  return (
    <div style={{ padding: 20 }}>
      <h1>Azure Subscription Mapper</h1>
      <Dashboard />
      <Search />
    </div>
  );
}
