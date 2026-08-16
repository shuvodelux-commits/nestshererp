// DELIBERATE VIOLATION FIXTURE — never copy this into a real package.
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import Database from 'better-sqlite3';

export const bad = [eq, Pool, Database];
