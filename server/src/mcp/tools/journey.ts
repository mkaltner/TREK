import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { isDemoUser } from '../../services/authService';
import {
  addContributor, addTripToJourney, canAccessJourney, createEntry, createJourney,
  addProviderPhoto, addProviderPhotoToGallery,
  deleteEntry, deleteJourney, getJourneyFull, getSuggestions, listEntries,
  listJourneys, listUserTrips, removeContributor, removeTripFromJourney,
  reorderEntries, updateContributorRole, updateEntry, updateJourney,
  updateJourneyPreferences,
} from '../../services/journeyService';
import { getAssetInfo as getImmichAssetInfo, searchPhotos as searchImmichPhotos } from '../../services/memories/immichService';
import {
  createOrUpdateJourneyShareLink, deleteJourneyShareLink, getJourneyShareLink,
} from '../../services/journeyShareService';
import { isAddonEnabled } from '../../services/adminService';
import { ADDON_IDS } from '../../addons';
import {
  TOOL_ANNOTATIONS_DELETE, TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE,
  demoDenied, ok,
} from './_shared';
import { canRead, canShareJourneys, canWrite } from '../scopes';

function notFound(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

function firstDate(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function deriveJourneyMediaWindow(journey: any, input: {
  from?: string;
  to?: string;
  tripId?: number;
  entryId?: number;
}): { from?: string; to?: string; tripId?: number } {
  let from = firstDate(input.from);
  let to = firstDate(input.to);
  let tripId = input.tripId;

  if (input.entryId) {
    const entry = (journey.entries || []).find((e: any) => e.id === input.entryId);
    if (entry?.entry_date) {
      from ||= entry.entry_date;
      to ||= entry.entry_date;
      tripId ||= entry.source_trip_id || undefined;
    }
  }

  if (tripId) {
    const trip = (journey.trips || []).find((t: any) => t.trip_id === tripId);
    if (trip) {
      from ||= trip.start_date;
      to ||= trip.end_date || trip.start_date;
    }
  }

  if (!from || !to) {
    const trips = journey.trips || [];
    const starts = trips.map((t: any) => t.start_date).filter(Boolean).sort();
    const ends = trips.map((t: any) => t.end_date || t.start_date).filter(Boolean).sort();
    from ||= starts[0];
    to ||= ends[ends.length - 1];
    tripId ||= trips[0]?.trip_id;
  }

  return { from, to, tripId };
}

function dateFromTakenAt(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function immichAssetUrls(assetId: string, ownerId: number, tripId?: number | null) {
  const proxyTripId = tripId || 0;
  return {
    thumbnailUrl: `/api/integrations/memories/immich/assets/${proxyTripId}/${assetId}/${ownerId}/thumbnail`,
    originalUrl: `/api/integrations/memories/immich/assets/${proxyTripId}/${assetId}/${ownerId}/original`,
  };
}

function attachedImmichAssetIds(journey: any): Set<string> {
  const ids = new Set<string>();
  for (const photo of journey.gallery || []) {
    if (photo.provider === 'immich' && photo.asset_id) ids.add(String(photo.asset_id));
  }
  for (const entry of journey.entries || []) {
    for (const photo of entry.photos || []) {
      if (photo.provider === 'immich' && photo.asset_id) ids.add(String(photo.asset_id));
    }
  }
  return ids;
}

function attachedImmichEntryIds(journey: any, assetId: string): number[] {
  const entryIds: number[] = [];
  for (const entry of journey.entries || []) {
    if ((entry.photos || []).some((photo: any) => photo.provider === 'immich' && String(photo.asset_id) === assetId)) {
      entryIds.push(entry.id);
    }
  }
  return entryIds;
}

function formatImmichCandidate(asset: any, alreadyAttached: Set<string>, ownerId: number, tripId?: number | null, journey?: any) {
  const providerAssetId = String(asset.id);
  return {
    provider: 'immich',
    providerAssetId,
    takenAt: asset.takenAt || null,
    takenDate: dateFromTakenAt(asset.takenAt),
    city: asset.city || null,
    country: asset.country || null,
    alreadyAttached: alreadyAttached.has(providerAssetId),
    attachedEntryIds: journey ? attachedImmichEntryIds(journey, providerAssetId) : [],
    ...immichAssetUrls(providerAssetId, ownerId, tripId),
  };
}

function summarizePhotoForMedia(photo: any) {
  const providerAssetId = photo.provider === 'immich' && photo.asset_id ? String(photo.asset_id) : null;
  return {
    ...photo,
    providerAssetId,
    assetId: providerAssetId,
  };
}

function summarizeEntryForMedia(entry: any) {
  const effectiveLat = entry.effective_location_lat ?? entry.location_lat ?? null;
  const effectiveLng = entry.effective_location_lng ?? entry.location_lng ?? null;
  return {
    id: entry.id,
    title: entry.title,
    story: entry.story || null,
    entry_date: entry.entry_date,
    entry_time: entry.entry_time,
    type: entry.type,
    location_name: entry.location_name,
    location_lat: entry.location_lat,
    location_lng: entry.location_lng,
    source_place_name: entry.source_place_name || null,
    source_place_address: entry.source_place_address || null,
    source_place_lat: entry.source_place_lat ?? null,
    source_place_lng: entry.source_place_lng ?? null,
    effective_location_name: entry.effective_location_name || entry.location_name || null,
    effective_location_lat: entry.effective_location_lat ?? entry.location_lat ?? null,
    effective_location_lng: entry.effective_location_lng ?? entry.location_lng ?? null,
    map_location: effectiveLat != null && effectiveLng != null
      ? {
        name: entry.effective_location_name || entry.location_name || null,
        lat: effectiveLat,
        lng: effectiveLng,
      }
      : null,
    source_trip_id: entry.source_trip_id,
    source_place_id: entry.source_place_id,
    photos: (entry.photos || []).map((photo: any) => summarizePhotoForMedia(photo)),
  };
}

export function registerJourneyTools(server: McpServer, userId: number, scopes: string[] | null): void {
  if (!isAddonEnabled(ADDON_IDS.JOURNEY)) return;

  const R = canRead(scopes, 'journey');
  const W = canWrite(scopes, 'journey');
  const S = canShareJourneys(scopes);

  // --- READ TOOLS ---

  if (R) server.registerTool(
    'list_journeys',
    {
      description: 'List all journeys owned or contributed to by the current user.',
      inputSchema: {},
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async () => {
      const journeys = listJourneys(userId);
      return ok({ journeys });
    }
  );

  if (R) server.registerTool(
    'get_journey',
    {
      description: 'Get a full journey including entries, contributors, and linked trips.',
      inputSchema: {
        journeyId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ journeyId }) => {
      const journey = getJourneyFull(journeyId, userId);
      if (!journey) return notFound('Journey not found or access denied.');
      return ok({ journey });
    }
  );

  if (R) server.registerTool(
    'list_journey_entries',
    {
      description: 'List all entries in a journey.',
      inputSchema: {
        journeyId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ journeyId }) => {
      if (!canAccessJourney(journeyId, userId)) return notFound('Journey not found or access denied.');
      const entries = listEntries(journeyId, userId);
      return ok({ entries });
    }
  );

  if (R) server.registerTool(
    'list_journey_contributors',
    {
      description: 'List all contributors (owner and collaborators) of a journey.',
      inputSchema: {
        journeyId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ journeyId }) => {
      const journey = getJourneyFull(journeyId, userId);
      if (!journey) return notFound('Journey not found or access denied.');
      return ok({ contributors: (journey as any).contributors ?? [] });
    }
  );

  if (R) server.registerTool(
    'get_journey_suggestions',
    {
      description: 'Get trip suggestions for creating a new journey (recently completed trips not yet in any journey).',
      inputSchema: {},
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async () => {
      const trips = getSuggestions(userId);
      return ok({ trips });
    }
  );

  if (R) server.registerTool(
    'list_journey_available_trips',
    {
      description: 'List all trips available to link to a journey.',
      inputSchema: {},
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async () => {
      const trips = listUserTrips(userId);
      return ok({ trips });
    }
  );

  if (R) server.registerTool(
    'journey_media_candidates',
    {
      description: 'Search Immich for image candidates matching a journey, linked trip, entry date, or explicit date range.',
      inputSchema: {
        journeyId: z.number().int().positive(),
        provider: z.literal('immich').default('immich'),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        tripId: z.number().int().positive().optional(),
        entryId: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ journeyId, from, to, tripId, entryId, limit }) => {
      const journey = getJourneyFull(journeyId, userId) as any;
      if (!journey) return notFound('Journey not found or access denied.');

      if (entryId && !(journey.entries || []).some((e: any) => e.id === entryId)) {
        return notFound('Entry not found in journey.');
      }
      if (tripId && !(journey.trips || []).some((t: any) => t.trip_id === tripId)) {
        return notFound('Trip is not linked to journey.');
      }

      const window = deriveJourneyMediaWindow(journey, { from, to, tripId, entryId });
      const result = await searchImmichPhotos(userId, window.from, window.to, 1, limit);
      if (result.error) {
        return { content: [{ type: 'text' as const, text: result.error }], isError: true };
      }

      const alreadyAttached = attachedImmichAssetIds(journey);
      const candidates = (result.assets || []).map((asset: any) => formatImmichCandidate(asset, alreadyAttached, userId, window.tripId, journey));

      return ok({
        journeyId,
        provider: 'immich',
        search: { from: window.from, to: window.to, tripId: window.tripId || null, entryId: entryId || null },
        candidates,
        hasMore: !!result.hasMore,
      });
    }
  );

  if (R) server.registerTool(
    'journey_entry_media_candidates',
    {
      description: 'Group Immich image candidates by Journey entry date so agents can rank and attach day/place photos.',
      inputSchema: {
        journeyId: z.number().int().positive(),
        provider: z.literal('immich').default('immich'),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        tripId: z.number().int().positive().optional(),
        perEntryLimit: z.number().int().min(1).max(50).default(12),
        searchLimit: z.number().int().min(1).max(500).default(200),
        includeEntriesWithoutCandidates: z.boolean().default(true),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ journeyId, from, to, tripId, perEntryLimit, searchLimit, includeEntriesWithoutCandidates }) => {
      const journey = getJourneyFull(journeyId, userId) as any;
      if (!journey) return notFound('Journey not found or access denied.');
      if (tripId && !(journey.trips || []).some((t: any) => t.trip_id === tripId)) {
        return notFound('Trip is not linked to journey.');
      }

      const window = deriveJourneyMediaWindow(journey, { from, to, tripId });
      const result = await searchImmichPhotos(userId, window.from, window.to, 1, searchLimit);
      if (result.error) {
        return { content: [{ type: 'text' as const, text: result.error }], isError: true };
      }

      const alreadyAttached = attachedImmichAssetIds(journey);
      const candidates = (result.assets || []).map((asset: any) => formatImmichCandidate(asset, alreadyAttached, userId, window.tripId, journey));
      const candidatesByDate = new Map<string, any[]>();
      for (const candidate of candidates) {
        if (!candidate.takenDate) continue;
        const list = candidatesByDate.get(candidate.takenDate) || [];
        list.push(candidate);
        candidatesByDate.set(candidate.takenDate, list);
      }

      const groupedEntries = (journey.entries || [])
        .filter((entry: any) => !tripId || entry.source_trip_id === tripId)
        .map((entry: any) => {
          const entryCandidates = (candidatesByDate.get(entry.entry_date) || []).slice(0, perEntryLimit);
          return {
            entry: summarizeEntryForMedia(entry),
            candidateCount: candidatesByDate.get(entry.entry_date)?.length || 0,
            candidates: entryCandidates,
          };
        })
        .filter((group: any) => includeEntriesWithoutCandidates || group.candidates.length > 0);

      const matched = new Set(groupedEntries.flatMap((group: any) => group.candidates.map((candidate: any) => candidate.providerAssetId)));
      const unmatchedCandidates = candidates.filter((candidate: any) => !matched.has(candidate.providerAssetId));

      return ok({
        journeyId,
        provider: 'immich',
        search: { from: window.from, to: window.to, tripId: window.tripId || null },
        entries: groupedEntries,
        unmatchedCandidates,
        hasMore: !!result.hasMore,
      });
    }
  );

  if (R) server.registerTool(
    'journey_entry_description_context',
    {
      description: 'Return entry, attached Immich photo metadata, and same-day candidates for writing Journey entry descriptions.',
      inputSchema: {
        journeyId: z.number().int().positive(),
        entryId: z.number().int().positive(),
        provider: z.literal('immich').default('immich'),
        candidateLimit: z.number().int().min(0).max(50).default(12),
        attachedLimit: z.number().int().min(0).max(50).default(20),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ journeyId, entryId, candidateLimit, attachedLimit }) => {
      const journey = getJourneyFull(journeyId, userId) as any;
      if (!journey) return notFound('Journey not found or access denied.');
      const entry = (journey.entries || []).find((e: any) => e.id === entryId);
      if (!entry) return notFound('Entry not found in journey.');

      const window = deriveJourneyMediaWindow(journey, { entryId });
      const alreadyAttached = attachedImmichAssetIds(journey);
      const candidateResult = candidateLimit > 0
        ? await searchImmichPhotos(userId, window.from, window.to, 1, candidateLimit)
        : { assets: [], hasMore: false };
      if ('error' in candidateResult && candidateResult.error) {
        return { content: [{ type: 'text' as const, text: candidateResult.error }], isError: true };
      }

      const attachedPhotos = (entry.photos || [])
        .filter((photo: any) => photo.provider === 'immich' && photo.asset_id)
        .slice(0, attachedLimit);
      const attachedMetadata = await Promise.all(attachedPhotos.map(async (photo: any) => {
        const info = await getImmichAssetInfo(userId, String(photo.asset_id));
        return {
          photo,
          asset: info.data || null,
          error: info.error || null,
        };
      }));

      const candidates = (candidateResult.assets || [])
        .map((asset: any) => formatImmichCandidate(asset, alreadyAttached, userId, window.tripId, journey));

      return ok({
        journeyId,
        entry: summarizeEntryForMedia(entry),
        search: { from: window.from, to: window.to, tripId: window.tripId || null, entryId },
        attachedPhotos: attachedMetadata,
        candidates,
        descriptionInputs: {
          title: entry.title || null,
          date: entry.entry_date,
          time: entry.entry_time || null,
          location: entry.location_name || null,
          coordinates: entry.location_lat != null && entry.location_lng != null
            ? { lat: entry.location_lat, lng: entry.location_lng }
            : null,
          effectiveLocation: entry.effective_location_name
            ? {
              name: entry.effective_location_name,
              lat: entry.effective_location_lat ?? null,
              lng: entry.effective_location_lng ?? null,
            }
            : null,
          existingStory: entry.story || null,
          candidateCount: candidates.length,
          attachedPhotoCount: attachedMetadata.length,
        },
      });
    }
  );

  if (R) server.registerTool(
    'journey_media_readback',
    {
      description: 'Read Journey cover, gallery, entries, and attached media for verification after Journey media writes.',
      inputSchema: {
        journeyId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ journeyId }) => {
      const journey = getJourneyFull(journeyId, userId) as any;
      if (!journey) return notFound('Journey not found or access denied.');
      return ok({
        journey: {
          id: journey.id,
          title: journey.title,
          cover_image: journey.cover_image || null,
          gallery: (journey.gallery || []).map((photo: any) => summarizePhotoForMedia(photo)),
          entries: (journey.entries || []).map((entry: any) => summarizeEntryForMedia(entry)),
        },
      });
    }
  );

  // --- WRITE TOOLS ---

  if (W) server.registerTool(
    'create_journey',
    {
      description: 'Create a new journey, optionally linking existing trips.',
      inputSchema: {
        title: z.string().min(1).max(200),
        subtitle: z.string().max(300).optional(),
        trip_ids: z.array(z.number().int().positive()).optional(),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ title, subtitle, trip_ids }) => {
      if (isDemoUser(userId)) return demoDenied();
      const journey = createJourney(userId, { title, subtitle, trip_ids });
      return ok({ journey });
    }
  );

  if (W) server.registerTool(
    'update_journey',
    {
      description: 'Update an existing journey\'s title, subtitle, cover, or status. Owner only.',
      inputSchema: {
        journeyId: z.number().int().positive(),
        title: z.string().min(1).max(200).optional(),
        subtitle: z.string().max(300).optional(),
        status: z.enum(['draft', 'active', 'completed', 'archived']).optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ journeyId, title, subtitle, status }) => {
      if (isDemoUser(userId)) return demoDenied();
      const journey = updateJourney(journeyId, userId, { title, subtitle, status });
      if (!journey) return notFound('Journey not found or access denied.');
      return ok({ journey });
    }
  );

  if (W) server.registerTool(
    'delete_journey',
    {
      description: 'Delete a journey. Owner only — this cannot be undone.',
      inputSchema: {
        journeyId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ journeyId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const success = deleteJourney(journeyId, userId);
      if (!success) return notFound('Journey not found or access denied.');
      return ok({ success: true });
    }
  );

  if (W) server.registerTool(
    'add_journey_trip',
    {
      description: 'Link a trip to a journey. Syncs skeleton entries for all places in the trip.',
      inputSchema: {
        journeyId: z.number().int().positive(),
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ journeyId, tripId }) => {
      if (isDemoUser(userId)) return demoDenied();
      if (!canAccessJourney(journeyId, userId)) return notFound('Journey not found or access denied.');
      const success = addTripToJourney(journeyId, tripId, userId);
      return ok({ success });
    }
  );

  if (W) server.registerTool(
    'remove_journey_trip',
    {
      description: 'Unlink a trip from a journey. Owner only.',
      inputSchema: {
        journeyId: z.number().int().positive(),
        tripId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ journeyId, tripId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const success = removeTripFromJourney(journeyId, tripId, userId);
      if (!success) return notFound('Journey not found or access denied.');
      return ok({ success });
    }
  );

  if (W) server.registerTool(
    'create_journey_entry',
    {
      description: 'Create a new entry in a journey.',
      inputSchema: {
        journeyId: z.number().int().positive(),
        entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Entry date (YYYY-MM-DD)'),
        title: z.string().max(300).optional(),
        story: z.string().optional(),
        description: z.string().optional().describe('Alias for story; useful for generated entry descriptions.'),
        entry_time: z.string().optional().describe('Time of day (e.g. "14:30")'),
        location_name: z.string().optional(),
        location_lat: z.number().min(-90).max(90).optional(),
        location_lng: z.number().min(-180).max(180).optional(),
        mood: z.string().optional(),
        sort_order: z.number().int().min(0).optional(),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ journeyId, entry_date, title, story, description, entry_time, location_name, location_lat, location_lng, mood, sort_order }) => {
      if (isDemoUser(userId)) return demoDenied();
      const entry = createEntry(journeyId, userId, { entry_date, title, story: story ?? description, entry_time, location_name, location_lat, location_lng, mood, sort_order });
      if (!entry) return notFound('Journey not found or access denied.');
      return ok({ entry });
    }
  );

  if (W) server.registerTool(
    'update_journey_entry',
    {
      description: 'Update an existing journey entry.',
      inputSchema: {
        entryId: z.number().int().positive(),
        title: z.string().max(300).optional(),
        story: z.string().optional(),
        description: z.string().optional().describe('Alias for story; useful for generated entry descriptions.'),
        entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        entry_time: z.string().optional(),
        location_name: z.string().optional(),
        location_lat: z.number().min(-90).max(90).optional(),
        location_lng: z.number().min(-180).max(180).optional(),
        mood: z.string().optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ entryId, title, story, description, entry_date, entry_time, location_name, location_lat, location_lng, mood }) => {
      if (isDemoUser(userId)) return demoDenied();
      const entry = updateEntry(entryId, userId, { title, story: story ?? description, entry_date, entry_time, location_name, location_lat, location_lng, mood }, undefined);
      if (!entry) return notFound('Entry not found or access denied.');
      return ok({ entry });
    }
  );

  if (W) server.registerTool(
    'delete_journey_entry',
    {
      description: 'Delete a journey entry.',
      inputSchema: {
        entryId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ entryId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const success = deleteEntry(entryId, userId, undefined);
      if (!success) return notFound('Entry not found or access denied.');
      return ok({ success: true });
    }
  );

  if (W) server.registerTool(
    'reorder_journey_entries',
    {
      description: 'Reorder entries within a journey by providing the desired order of entry IDs.',
      inputSchema: {
        journeyId: z.number().int().positive(),
        orderedIds: z.array(z.number().int().positive()),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ journeyId, orderedIds }) => {
      if (isDemoUser(userId)) return demoDenied();
      const success = reorderEntries(journeyId, userId, orderedIds, undefined);
      if (!success) return notFound('Journey not found, access denied, or entry IDs do not belong to this journey.');
      return ok({ success: true });
    }
  );

  if (W) server.registerTool(
    'add_journey_contributor',
    {
      description: 'Add a contributor to a journey. Owner only.',
      inputSchema: {
        journeyId: z.number().int().positive(),
        targetUserId: z.number().int().positive(),
        role: z.enum(['editor', 'viewer']),
      },
      annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
    },
    async ({ journeyId, targetUserId, role }) => {
      if (isDemoUser(userId)) return demoDenied();
      const success = addContributor(journeyId, userId, targetUserId, role);
      if (!success) return notFound('Journey not found or access denied.');
      return ok({ success: true });
    }
  );

  if (W) server.registerTool(
    'update_journey_contributor_role',
    {
      description: 'Update the role of a journey contributor. Owner only.',
      inputSchema: {
        journeyId: z.number().int().positive(),
        targetUserId: z.number().int().positive(),
        role: z.enum(['editor', 'viewer']),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ journeyId, targetUserId, role }) => {
      if (isDemoUser(userId)) return demoDenied();
      const success = updateContributorRole(journeyId, userId, targetUserId, role);
      if (!success) return notFound('Journey not found or access denied.');
      return ok({ success: true });
    }
  );

  if (W) server.registerTool(
    'remove_journey_contributor',
    {
      description: 'Remove a contributor from a journey. Owner only.',
      inputSchema: {
        journeyId: z.number().int().positive(),
        targetUserId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ journeyId, targetUserId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const success = removeContributor(journeyId, userId, targetUserId);
      if (!success) return notFound('Journey not found or access denied.');
      return ok({ success: true });
    }
  );

  if (W) server.registerTool(
    'update_journey_preferences',
    {
      description: 'Update per-user preferences for a journey (e.g. hide skeleton entries).',
      inputSchema: {
        journeyId: z.number().int().positive(),
        hide_skeletons: z.boolean().optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ journeyId, hide_skeletons }) => {
      if (isDemoUser(userId)) return demoDenied();
      const result = updateJourneyPreferences(journeyId, userId, { hide_skeletons });
      if (!result) return notFound('Journey not found or access denied.');
      return ok({ success: true });
    }
  );

  if (W) server.registerTool(
    'journey_gallery_attach_provider_asset',
    {
      description: 'Attach an Immich provider asset to a Journey gallery. Idempotent for existing provider assets.',
      inputSchema: {
        journeyId: z.number().int().positive(),
        provider: z.literal('immich').default('immich'),
        providerAssetId: z.string().min(1),
        caption: z.string().max(500).optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ journeyId, providerAssetId, caption }) => {
      if (isDemoUser(userId)) return demoDenied();
      const photo = addProviderPhotoToGallery(journeyId, userId, 'immich', providerAssetId, caption);
      if (!photo) return notFound('Journey not found, access denied, or photo already attached.');
      const journey = getJourneyFull(journeyId, userId);
      return ok({ photo, journey });
    }
  );

  if (W) server.registerTool(
    'journey_entry_attach_provider_asset',
    {
      description: 'Attach an Immich provider asset to a Journey entry and ensure it is present in the Journey gallery.',
      inputSchema: {
        journeyId: z.number().int().positive(),
        entryId: z.number().int().positive(),
        provider: z.literal('immich').default('immich'),
        providerAssetId: z.string().min(1),
        caption: z.string().max(500).optional(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ journeyId, entryId, providerAssetId, caption }) => {
      if (isDemoUser(userId)) return demoDenied();
      const journey = getJourneyFull(journeyId, userId) as any;
      if (!journey) return notFound('Journey not found or access denied.');
      if (!(journey.entries || []).some((e: any) => e.id === entryId)) return notFound('Entry not found in journey.');

      const photo = addProviderPhoto(entryId, userId, 'immich', providerAssetId, caption);
      if (!photo) return notFound('Entry not found, access denied, or photo already attached.');
      const updated = getJourneyFull(journeyId, userId);
      return ok({ photo, journey: updated });
    }
  );

  // --- SHARE TOOLS ---

  if (S) server.registerTool(
    'get_journey_share_link',
    {
      description: 'Get the current public share link for a journey. Returns null if none exists.',
      inputSchema: {
        journeyId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_READONLY,
    },
    async ({ journeyId }) => {
      const shareLink = getJourneyShareLink(journeyId);
      return ok({ shareLink });
    }
  );

  if (S) server.registerTool(
    'create_journey_share_link',
    {
      description: 'Create or update the public share link for a journey. Owner only.',
      inputSchema: {
        journeyId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_WRITE,
    },
    async ({ journeyId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const shareLink = createOrUpdateJourneyShareLink(journeyId, userId, {});
      if (!shareLink) return notFound('Journey not found or access denied.');
      return ok({ shareLink });
    }
  );

  if (S) server.registerTool(
    'delete_journey_share_link',
    {
      description: 'Revoke the public share link for a journey. Owner only.',
      inputSchema: {
        journeyId: z.number().int().positive(),
      },
      annotations: TOOL_ANNOTATIONS_DELETE,
    },
    async ({ journeyId }) => {
      if (isDemoUser(userId)) return demoDenied();
      const success = deleteJourneyShareLink(journeyId, userId);
      if (!success) return notFound('Journey not found or access denied.');
      return ok({ success: true });
    }
  );
}
