/**
 * Additive capability evidence for ordinary root routing. The renderer never
 * receives these provider-generation fields; they only fence gateway effects.
 */
export const ROOT_TURN_ROUTING_CAPABILITY_SCHEMA_V1_SQL = `
  ALTER TABLE harness_root_turn_routing_receipts
    ADD COLUMN required_input_class TEXT NOT NULL DEFAULT 'text'
      CHECK (required_input_class IN ('text', 'image'));

  ALTER TABLE harness_root_turn_routing_receipts
    ADD COLUMN catalog_generation INTEGER
      CHECK (catalog_generation IS NULL OR catalog_generation > 0);

  ALTER TABLE harness_root_turn_routing_receipts
    ADD COLUMN catalog_digest TEXT CHECK (
      catalog_digest IS NULL OR (
        length(catalog_digest) = 64
        AND catalog_digest NOT GLOB '*[^0-9a-f]*'
      )
    );

  CREATE TRIGGER harness_root_route_input_class_immutable
  BEFORE UPDATE OF required_input_class
  ON harness_root_turn_routing_receipts
  WHEN NEW.required_input_class != OLD.required_input_class
  BEGIN
    SELECT RAISE(ABORT, 'root route input class is immutable');
  END;

  CREATE TRIGGER harness_root_route_catalog_pair_insert
  BEFORE INSERT ON harness_root_turn_routing_receipts
  WHEN (NEW.catalog_generation IS NULL) != (NEW.catalog_digest IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'root route catalog evidence must be complete');
  END;

  CREATE TRIGGER harness_root_route_catalog_pair_update
  BEFORE UPDATE OF catalog_generation, catalog_digest
  ON harness_root_turn_routing_receipts
  WHEN (NEW.catalog_generation IS NULL) != (NEW.catalog_digest IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'root route catalog evidence must be complete');
  END;

  CREATE TRIGGER harness_root_route_catalog_resolution_only
  BEFORE UPDATE OF catalog_generation, catalog_digest
  ON harness_root_turn_routing_receipts
  WHEN OLD.catalog_generation IS NULL AND (
    OLD.state != 'classified'
    OR NEW.state != 'resolved'
    OR NEW.catalog_generation IS NULL
    OR NEW.catalog_digest IS NULL
  )
  BEGIN
    SELECT RAISE(ABORT, 'root route catalog evidence requires exact resolution');
  END;

  CREATE TRIGGER harness_root_route_catalog_immutable
  BEFORE UPDATE OF catalog_generation, catalog_digest
  ON harness_root_turn_routing_receipts
  WHEN OLD.catalog_generation IS NOT NULL AND (
    NEW.catalog_generation != OLD.catalog_generation
    OR NEW.catalog_digest != OLD.catalog_digest
  )
  BEGIN
    SELECT RAISE(ABORT, 'root route catalog evidence is immutable');
  END;

  CREATE TRIGGER harness_root_route_effect_requires_catalog
  BEFORE UPDATE OF state ON harness_root_turn_routing_receipts
  WHEN NEW.state IN ('effectStarted', 'accepted', 'terminal', 'ambiguous')
    AND (NEW.catalog_generation IS NULL OR NEW.catalog_digest IS NULL)
  BEGIN
    SELECT RAISE(ABORT, 'root route provider effect requires catalog evidence');
  END;

  CREATE TRIGGER harness_root_route_accepts_catalog_generation
  BEFORE UPDATE OF accepted_generation ON harness_root_turn_routing_receipts
  WHEN NEW.accepted_generation IS NOT NULL
    AND NEW.accepted_generation != NEW.catalog_generation
  BEGIN
    SELECT RAISE(ABORT, 'root route acceptance generation differs from catalog');
  END;
`;
