const API = import.meta.env.VITE_API_URL || '';

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${API}${url}`, { ...options, headers, credentials: 'include' });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || 'Ошибка запроса');
  return data as T;
}

export const api = {
  setupStatus: () => request<{needsSetup:boolean;setupConfigured:boolean}>('/api/setup/status'),
  setupTeacher: (payload:{setupKey:string;username:string;password:string;displayName:string}) => request<any>('/api/setup/teacher',{method:'POST',body:JSON.stringify(payload)}),
  login: (username:string,password:string) => request<any>('/api/auth/login',{method:'POST',body:JSON.stringify({username,password})}),
  me: () => request<any>('/api/auth/me'),
  logout: () => request<void>('/api/auth/logout',{method:'POST'}),
  tests: () => request<any[]>('/api/tests'),
  test: (id:string) => request<any>(`/api/tests/${id}`),
  createTest: (payload:any) => request<any>('/api/tests',{method:'POST',body:JSON.stringify(payload)}),
  updateTest: (id:string,payload:any) => request<any>(`/api/tests/${id}`,{method:'PUT',body:JSON.stringify(payload)}),
  publish: (id:string,published:boolean) => request<any>(`/api/tests/${id}/publish`,{method:'POST',body:JSON.stringify({published})}),
  duplicate: (id:string) => request<any>(`/api/tests/${id}/duplicate`,{method:'POST'}),
  deleteTest: (id:string) => request<void>(`/api/tests/${id}`,{method:'DELETE'}),
  versions: (id:string) => request<any[]>(`/api/tests/${id}/versions`),
  bank: () => request<any[]>('/api/question-bank'),
  importQuestions: (testId:string,questionIds:string[]) => request<any>(`/api/tests/${testId}/import`,{method:'POST',body:JSON.stringify({questionIds})}),
  join: (code:string,studentName:string) => request<any>(`/api/join/${encodeURIComponent(code)}`,{method:'POST',body:JSON.stringify({studentName})}),
  attempt: (id:string,token:string) => request<any>(`/api/attempts/${id}`,{headers:{'X-Attempt-Token':token}}),
  heartbeat: (id:string,token:string) => request<any>(`/api/attempts/${id}/heartbeat`,{method:'POST',headers:{'X-Attempt-Token':token}}),
  answer: (id:string,token:string,questionId:string,answer:any,clientUpdatedAt=Date.now()) => request<any>(`/api/attempts/${id}/answers`,{method:'POST',headers:{'X-Attempt-Token':token},body:JSON.stringify({questionId,answer,clientUpdatedAt})}),
  event: (id:string,token:string,type:string,payload:any={}) => request<any>(`/api/attempts/${id}/events`,{method:'POST',headers:{'X-Attempt-Token':token},body:JSON.stringify({type,payload})}),
  submit: (id:string,token:string) => request<any>(`/api/attempts/${id}/submit`,{method:'POST',headers:{'X-Attempt-Token':token}}),
  results: (testId:string) => request<any[]>(`/api/tests/${testId}/results`),
  events: (attemptId:string) => request<any[]>(`/api/attempts/${attemptId}/events`),
  detail: (attemptId:string) => request<any>(`/api/attempts/${attemptId}/detail`),
  manualGrade: (attemptId:string,questionId:string,points:number,feedback:string) => request<any>(`/api/attempts/${attemptId}/manual-grade`,{method:'POST',body:JSON.stringify({questionId,points,feedback})}),
  review: (attemptId:string) => request<any>(`/api/attempts/${attemptId}/review`,{method:'POST'})
};

export function clearSession(){ localStorage.removeItem('qf_theme'); }
