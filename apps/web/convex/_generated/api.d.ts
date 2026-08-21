/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents from "../agents.js";
import type * as auth from "../auth.js";
import type * as authorization from "../authorization.js";
import type * as boundedJsonBody from "../boundedJsonBody.js";
import type * as crons from "../crons.js";
import type * as crypto from "../crypto.js";
import type * as desktopPairing from "../desktopPairing.js";
import type * as dispatch from "../dispatch.js";
import type * as dispatchAuthorization from "../dispatchAuthorization.js";
import type * as dispatchInteractionLaws from "../dispatchInteractionLaws.js";
import type * as dispatchInteractions from "../dispatchInteractions.js";
import type * as dispatchLaws from "../dispatchLaws.js";
import type * as dispatchReconciliation from "../dispatchReconciliation.js";
import type * as dispatchSafety from "../dispatchSafety.js";
import type * as domain from "../domain.js";
import type * as events from "../events.js";
import type * as hostedMutationAttempts from "../hostedMutationAttempts.js";
import type * as hostedMutationFingerprint from "../hostedMutationFingerprint.js";
import type * as hostedMutationPersistence from "../hostedMutationPersistence.js";
import type * as hraEnvironment from "../hraEnvironment.js";
import type * as hraHttp from "../hraHttp.js";
import type * as hraHuman from "../hraHuman.js";
import type * as hraProjection from "../hraProjection.js";
import type * as hraPromotion from "../hraPromotion.js";
import type * as hraPromotionProjection from "../hraPromotionProjection.js";
import type * as http from "../http.js";
import type * as humanAdmin from "../humanAdmin.js";
import type * as humanAdminFingerprint from "../humanAdminFingerprint.js";
import type * as humanAuthorization from "../humanAuthorization.js";
import type * as humanTaskDetail from "../humanTaskDetail.js";
import type * as humanTaskMutations from "../humanTaskMutations.js";
import type * as humanTaskProjection from "../humanTaskProjection.js";
import type * as humanTaskQueries from "../humanTaskQueries.js";
import type * as humanTaskWorkspace from "../humanTaskWorkspace.js";
import type * as humanTenancy from "../humanTenancy.js";
import type * as identityCutover from "../identityCutover.js";
import type * as localFixtures from "../localFixtures.js";
import type * as model from "../model.js";
import type * as operatorDiagnostics from "../operatorDiagnostics.js";
import type * as passwordMigrations from "../passwordMigrations.js";
import type * as rateLimitPolicy from "../rateLimitPolicy.js";
import type * as rateLimits from "../rateLimits.js";
import type * as receiptMaintenance from "../receiptMaintenance.js";
import type * as schedules from "../schedules.js";
import type * as sessionSync from "../sessionSync.js";
import type * as sessionSyncHttp from "../sessionSyncHttp.js";
import type * as sessionSyncLaws from "../sessionSyncLaws.js";
import type * as sessionSyncModel from "../sessionSyncModel.js";
import type * as sessionSyncScheduledChats from "../sessionSyncScheduledChats.js";
import type * as sessionSyncSchemas from "../sessionSyncSchemas.js";
import type * as suiteIdentity from "../suiteIdentity.js";
import type * as suiteIdentityAudit from "../suiteIdentityAudit.js";
import type * as suiteIdentityModel from "../suiteIdentityModel.js";
import type * as suiteIdentityRules from "../suiteIdentityRules.js";
import type * as tasks from "../tasks.js";
import type * as workGraph from "../workGraph.js";
import type * as workGraphLaws from "../workGraphLaws.js";
import type * as workspaceIntegrity from "../workspaceIntegrity.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agents: typeof agents;
  auth: typeof auth;
  authorization: typeof authorization;
  boundedJsonBody: typeof boundedJsonBody;
  crons: typeof crons;
  crypto: typeof crypto;
  desktopPairing: typeof desktopPairing;
  dispatch: typeof dispatch;
  dispatchAuthorization: typeof dispatchAuthorization;
  dispatchInteractionLaws: typeof dispatchInteractionLaws;
  dispatchInteractions: typeof dispatchInteractions;
  dispatchLaws: typeof dispatchLaws;
  dispatchReconciliation: typeof dispatchReconciliation;
  dispatchSafety: typeof dispatchSafety;
  domain: typeof domain;
  events: typeof events;
  hostedMutationAttempts: typeof hostedMutationAttempts;
  hostedMutationFingerprint: typeof hostedMutationFingerprint;
  hostedMutationPersistence: typeof hostedMutationPersistence;
  hraEnvironment: typeof hraEnvironment;
  hraHttp: typeof hraHttp;
  hraHuman: typeof hraHuman;
  hraProjection: typeof hraProjection;
  hraPromotion: typeof hraPromotion;
  hraPromotionProjection: typeof hraPromotionProjection;
  http: typeof http;
  humanAdmin: typeof humanAdmin;
  humanAdminFingerprint: typeof humanAdminFingerprint;
  humanAuthorization: typeof humanAuthorization;
  humanTaskDetail: typeof humanTaskDetail;
  humanTaskMutations: typeof humanTaskMutations;
  humanTaskProjection: typeof humanTaskProjection;
  humanTaskQueries: typeof humanTaskQueries;
  humanTaskWorkspace: typeof humanTaskWorkspace;
  humanTenancy: typeof humanTenancy;
  identityCutover: typeof identityCutover;
  localFixtures: typeof localFixtures;
  model: typeof model;
  operatorDiagnostics: typeof operatorDiagnostics;
  passwordMigrations: typeof passwordMigrations;
  rateLimitPolicy: typeof rateLimitPolicy;
  rateLimits: typeof rateLimits;
  receiptMaintenance: typeof receiptMaintenance;
  schedules: typeof schedules;
  sessionSync: typeof sessionSync;
  sessionSyncHttp: typeof sessionSyncHttp;
  sessionSyncLaws: typeof sessionSyncLaws;
  sessionSyncModel: typeof sessionSyncModel;
  sessionSyncScheduledChats: typeof sessionSyncScheduledChats;
  sessionSyncSchemas: typeof sessionSyncSchemas;
  suiteIdentity: typeof suiteIdentity;
  suiteIdentityAudit: typeof suiteIdentityAudit;
  suiteIdentityModel: typeof suiteIdentityModel;
  suiteIdentityRules: typeof suiteIdentityRules;
  tasks: typeof tasks;
  workGraph: typeof workGraph;
  workGraphLaws: typeof workGraphLaws;
  workspaceIntegrity: typeof workspaceIntegrity;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
