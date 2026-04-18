import { promises as fs, mkdirSync } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { Scene, Stage } from '@/lib/types/stage';

// Protected paths we refuse to write into. A typo in DATA_DIR (trailing slash collapsed, shell
// expansion misfire, empty var after trim) should crash the process at import time, not silently
// start dropping JSON into /etc or /usr.
const DATA_DIR_DENYLIST = new Set([
  '/',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/boot',
  '/proc',
  '/sys',
  '/dev',
  '/root',
  '/var',
]);

function resolveDataDir(): string {
  const raw = process.env.DATA_DIR?.trim();
  // Fallback is <cwd>/data. In the shipped Docker image WORKDIR is /app (see Dockerfile), so
  // `process.cwd()` → `/app` and the effective default is `/app/data` — matching the prior hard-
  // coded behaviour and the `openmaic-data:/app/data` volume mount in docker-compose.yml.
  // Caveat: Next.js standalone bundles may resolve cwd to `.next/standalone/` depending on how
  // `node server.js` is launched. Set DATA_DIR explicitly outside of Docker to avoid surprises.
  const resolved = raw && raw.length > 0 ? path.resolve(raw) : path.join(process.cwd(), 'data');
  if (DATA_DIR_DENYLIST.has(resolved)) {
    throw new Error(
      `DATA_DIR resolved to a protected system path: ${resolved}. ` +
        `Choose a dedicated directory (e.g. /app/data or /mnt/openmaic).`,
    );
  }
  return resolved;
}

export const DATA_DIR = resolveDataDir();
export const CLASSROOMS_DIR = path.join(DATA_DIR, 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(DATA_DIR, 'classroom-jobs');

// Eager sync mkdir at module load. Fresh EFS/NFS or bind mounts start empty and the first write
// anywhere would ENOENT; lazy per-write ensureXxxDir helpers (below) work but depend on call order.
// Doing this here also surfaces permission problems at boot with a clear message rather than as a
// cryptic 500 on the first request hours later.
try {
  mkdirSync(CLASSROOMS_DIR, { recursive: true });
  mkdirSync(CLASSROOM_JOBS_DIR, { recursive: true });
} catch (err) {
  throw new Error(
    `Failed to initialise DATA_DIR=${DATA_DIR}: ${(err as Error).message}. ` +
      `Ensure the directory is writable by the container user (uid 1001 in the stock Dockerfile). ` +
      `For a bind-mounted host dir: chown -R 1001:1001 <host-path>.`,
  );
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureClassroomsDir() {
  await ensureDir(CLASSROOMS_DIR);
}

export async function ensureClassroomJobsDir() {
  await ensureDir(CLASSROOM_JOBS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}

export function buildRequestOrigin(req: NextRequest): string {
  return req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('x-forwarded-host')}`
    : req.nextUrl.origin;
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  createdAt: string;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as PersistedClassroomData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: new Date().toISOString(),
  };

  await ensureClassroomsDir();
  const filePath = path.join(CLASSROOMS_DIR, `${data.id}.json`);
  await writeJsonFileAtomic(filePath, classroomData);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}
