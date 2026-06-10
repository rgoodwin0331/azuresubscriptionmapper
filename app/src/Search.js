import { useState } from 'react';
import { search } from './api';

export default function Search() {
  const [q, setQ] = useState('');
  const [type, setType] = useState('company');
  const [results, setResults] = useState([]);

  const runSearch = async () => {
    const data = await search(q, type);
    setResults(data);
  };

  return (
    <div>
      <h2>Search</h2>
      <input value={q} onChange={e => setQ(e.target.value)} />
      <select onChange={e => setType(e.target.value)}>
        <option value="company">Company</option>
        <option value="subscription">Subscription</option>
      </select>
      <button onClick={runSearch}>Search</button>
      <ul>
        {results.map((r, i) => <li key={i}>{JSON.stringify(r)}</li>)}
      </ul>
    </div>
  );
}
