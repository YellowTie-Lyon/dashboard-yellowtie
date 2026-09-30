import { getSupabase } from '../../lib/supabase'

export interface StorageStats {
  db_bytes: number
  tables: { name: string; bytes: number; rows: number }[]
}

export async function fetchStorageStats(): Promise<StorageStats | null> {
  const { data, error } = await getSupabase().rpc('get_storage_stats')
  if (error) throw error
  return (data ?? null) as StorageStats | null
}
