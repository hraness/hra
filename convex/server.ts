import {
  actionGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import type {
  ActionBuilder,
  DataModelFromSchemaDefinition,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  MutationBuilder,
  QueryBuilder,
} from "convex/server";

import type schema from "./schema";

type InferredDataModel = DataModelFromSchemaDefinition<typeof schema>;

// Convex Auth's published table validators spell optional fields as
// `field?: T | undefined`, while GenericDataModel's index signature excludes
// explicit undefined. The intersection preserves our inferred tables and
// supplies the generic builder constraint until upstream aligns those types.
export type DataModel = InferredDataModel & GenericDataModel;
export type ActionCtx = GenericActionCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type QueryCtx = GenericQueryCtx<DataModel>;

export const query: QueryBuilder<DataModel, "public"> = queryGeneric;
export const internalQuery: QueryBuilder<DataModel, "internal"> = internalQueryGeneric;
export const mutation: MutationBuilder<DataModel, "public"> = mutationGeneric;
export const internalMutation: MutationBuilder<DataModel, "internal"> =
  internalMutationGeneric;
export const action: ActionBuilder<DataModel, "public"> = actionGeneric;
export const internalAction: ActionBuilder<DataModel, "internal"> =
  internalActionGeneric;
