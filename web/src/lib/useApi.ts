import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

type ApiState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};

export function useApi<T>(path: string | null) {
  const [state, setState] = useState<ApiState<T>>({
    data: null,
    loading: Boolean(path),
    error: null,
  });

  const load = useCallback(
    async (quiet = false): Promise<void> => {
      if (!path) {
        setState({ data: null, loading: false, error: null });
        return;
      }
      if (!quiet) {
        setState((prev) => ({ ...prev, loading: true, error: null }));
      }
      try {
        const data = await api.get<T>(path);
        setState({ data, loading: false, error: null });
      } catch (error) {
        setState((prev) => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error.message : 'Request failed',
        }));
      }
    },
    [path],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return { ...state, refetch: load };
}
