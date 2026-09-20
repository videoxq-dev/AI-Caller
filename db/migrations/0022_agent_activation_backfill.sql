-- Keep previously serving single-agent workspaces functional when status begins
-- controlling live conversational work. New agents remain DRAFT until activated.
-- Promote only existing workspaces with direct evidence of an in-use agent.
UPDATE ai_agents AS agent
   SET status = 'ACTIVE', updated_at = now()
 WHERE agent.status = 'DRAFT'
   AND (
     EXISTS (
       SELECT 1 FROM hosted_phone_numbers AS number
        WHERE number.workspace_id = agent.workspace_id
          AND number.status = 'ACTIVE' AND number.released_at IS NULL
     )
     OR EXISTS (
       SELECT 1 FROM setup_progress AS progress
        WHERE progress.workspace_id = agent.workspace_id
          AND progress.live_completed_at IS NOT NULL
     )
     OR EXISTS (
       SELECT 1 FROM conversations AS conversation
         JOIN messages AS message ON message.conversation_id = conversation.id
        WHERE conversation.workspace_id = agent.workspace_id
          AND message.workspace_id = agent.workspace_id
          AND message.sender_type = 'AI'
     )
   );
