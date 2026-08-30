import type { DirectorStatus } from '../types/director'

export const isDirectorActive = (status: DirectorStatus) =>
  status === 'thinking' || status === 'publishing'
