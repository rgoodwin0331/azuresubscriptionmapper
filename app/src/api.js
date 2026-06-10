export async function getDashboard(){return fetch('/api/dashboard').then(r=>r.json());}
export async function search(q,type){return fetch(`/api/search?q=${q}&type=${type}`).then(r=>r.json());}
