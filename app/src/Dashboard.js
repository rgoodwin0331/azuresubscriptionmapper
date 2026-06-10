import { useEffect, useState } from 'react';
import { getDashboard } from './api';

export default function Dashboard() {
  const [data, setData] = useState(null);

  useEffect(() => {
    getDashboard().then(setData);
  }, []);

  if (!data) return <div>Loading...</div>;

  return (
    <div>
      <h2>Dashboard</h2>
      <div>Total Accounts: {data.TotalAccounts}</div>
      <div>Total Subscriptions: {data.TotalSubscriptions}</div>
      <div>Accounts w/ Multiple Subs: {data.AccountsWithMultipleSubscriptions}</div>
      <div>Unmapped Subscriptions: {data.UnmappedSubscriptions}</div>
    </div>
  );
}
