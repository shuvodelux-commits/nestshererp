// DELIBERATE VIOLATION FIXTURE — never copy this into a real package.
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { join } from 'node:path';

export const bad = [Injectable, sql, Client, join];
