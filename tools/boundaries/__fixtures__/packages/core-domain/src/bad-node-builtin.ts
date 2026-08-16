// DELIBERATE VIOLATION FIXTURE — never copy this into a real package.
import { readFileSync } from 'fs';
import { randomUUID } from 'node:crypto';

export const bad = [readFileSync, randomUUID];
