import { stopApi } from './support/stack';

/** Leaves the database in place: a failed run is worth looking at afterwards. */
async function globalTeardown(): Promise<void> {
  await stopApi();
}

export default globalTeardown;
