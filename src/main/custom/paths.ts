import path from 'node:path'
import { dataDir } from '../utils/dirs'

export function localCoreDir(): string {
  return path.join(dataDir(), 'cores')
}
