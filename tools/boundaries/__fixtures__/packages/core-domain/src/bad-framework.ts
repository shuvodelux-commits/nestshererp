// DELIBERATE VIOLATION FIXTURE — never copy this into a real package.
import { Injectable } from '@nestjs/common';
import express from 'express';

export const bad = [Injectable, express];
