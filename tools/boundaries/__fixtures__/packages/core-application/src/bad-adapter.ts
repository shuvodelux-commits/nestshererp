// DELIBERATE VIOLATION FIXTURE — never copy this into a real package.
import { PostgresSaleRepository } from '@sher/adapter-postgres';

const lazy = async (): Promise<unknown> => import('../../adapter-postgres/src/index');

export const bad = [PostgresSaleRepository, lazy];
