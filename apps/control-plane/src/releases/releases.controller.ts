import { Body, Controller, Get, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { releaseChannelSchema } from '@sher/control-contracts';
import type { Response } from 'express';
import { createReadStream } from 'node:fs';
import { z } from 'zod';

import { ControlError, ControlErrorCode } from '../common/errors';
import { Agent, AgentAuthGuard } from '../installations/agent-auth.guard';
import type { AgentPrincipal } from '../installations/agent-auth.guard';
import { Operator, OperatorGuard, RequirePermission } from '../operators/operator.guard';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { ReleasesService } from './releases.service';
import { RELEASES_SERVICE } from '../tokens';

const publishSchema = z
  .object({
    version: z.string().min(1).max(40),
    buildId: z.string().min(1).max(64),
    /** A filename in the release directory — never a path (see the service). */
    artifactFile: z.string().min(1).max(200),
    requiredSchemaVersion: z.string().min(1).max(64),
    minCompatibleVersion: z.string().min(1).max(40),
    migrations: z.array(z.string().max(200)).default([]),
    rollbackSupported: z.boolean().default(false),
    channel: releaseChannelSchema.default('INTERNAL'),
    notes: z.string().max(5000).default(''),
    reason: z.string().min(3).max(500),
  })
  .strict();

@Controller('api/control/releases')
export class ReleasesController {
  constructor(@Inject(RELEASES_SERVICE) private readonly releases: ReleasesService) {}

  @Get()
  @UseGuards(OperatorGuard)
  @RequirePermission('release.view')
  async list(): Promise<unknown> {
    return { releases: await this.releases.list() };
  }

  @Post()
  @UseGuards(OperatorGuard)
  @RequirePermission('release.publish')
  async publish(@Body() body: unknown, @Operator() operator: OperatorPrincipal): Promise<unknown> {
    const parsed = publishSchema.safeParse(body);
    if (!parsed.success) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'Check the release details');
    }
    return this.releases.publish(parsed.data, operator);
  }
}

/**
 * Artifact download, for agents only.
 *
 * Deliberately behind `AgentAuthGuard`: a build is not a secret, but an
 * unauthenticated download endpoint is a free copy of the vendor's product and
 * a free target for anyone wanting to fingerprint versions. The signature on
 * the manifest is what makes the *content* trustworthy; this makes the
 * *distribution* deliberate.
 */
@Controller('api/agent/releases')
export class ReleaseArtifactController {
  constructor(@Inject(RELEASES_SERVICE) private readonly releases: ReleasesService) {}

  @Get(':id/artifact')
  @UseGuards(AgentAuthGuard)
  async artifact(
    @Param('id') id: string,
    @Res() response: Response,
    @Agent() agent: AgentPrincipal,
  ): Promise<void> {
    void agent;
    const path = await this.releases.artifactPathFor(id);
    response.setHeader('content-type', 'application/gzip');
    createReadStream(path).pipe(response);
  }
}
