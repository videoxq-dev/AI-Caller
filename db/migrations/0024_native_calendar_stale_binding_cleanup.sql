-- Remove stale external calendar routes so runtime can use the built-in
-- scheduler when the selected provider is missing, disconnected, or in error.
DELETE FROM capability_bindings AS binding
WHERE binding.capability = 'CALENDAR'
  AND (
    binding.integration_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM integrations AS integration
      WHERE integration.id = binding.integration_id
        AND integration.workspace_id = binding.workspace_id
        AND integration.category = 'CALENDAR'
        AND integration.status = 'CONNECTED'
    )
  );
