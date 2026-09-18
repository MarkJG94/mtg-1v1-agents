/** Shape returned by the server's `GET /api/health`. */
export interface Health {
  status: 'ok';
  version: string;
  simWorkers: number;
  uptimeSeconds: number;
}

export const fetchHealth = async (): Promise<Health> => {
  const response = await fetch('/api/health');
  if (!response.ok) throw new Error(`health check failed: ${response.status}`);
  return (await response.json()) as Health;
};
