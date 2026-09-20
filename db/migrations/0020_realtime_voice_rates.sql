-- Realtime voice uses actual OpenAI audio/text token usage + Telnyx US local
-- voice/media/recording charges. These rows store PROVIDER cost, not retail.
-- Retail is computed with an explicit 50% cost markup in realtime-voice.ts;
-- do not apply the legacy hosted rate card gross-margin setting again.
-- Snapshot these rates at session start; provider list rates can change.
INSERT INTO "hosted_api_rate_cards"
  ("capability", "provider", "model", "unit",
   "cost_micros", "units_per_cost", "target_margin_bps", "effective_from", "metadata")
VALUES
  ('VOICE', 'openai', 'gpt-realtime-2.1',
   'VOICE_REALTIME_AUDIO_INPUT_TOKEN', 32000000, 1000000, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","basis":"2026-09-20_openai_realtime_2_1"}'),
  ('VOICE', 'openai', 'gpt-realtime-2.1',
   'VOICE_REALTIME_AUDIO_CACHED_INPUT_TOKEN', 400000, 1000000, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","basis":"2026-09-20_openai_realtime_2_1"}'),
  ('VOICE', 'openai', 'gpt-realtime-2.1',
   'VOICE_REALTIME_AUDIO_OUTPUT_TOKEN', 64000000, 1000000, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","basis":"2026-09-20_openai_realtime_2_1"}'),
  ('VOICE', 'openai', 'gpt-realtime-2.1',
   'VOICE_REALTIME_TEXT_INPUT_TOKEN', 4000000, 1000000, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","basis":"2026-09-20_openai_realtime_2_1"}'),
  ('VOICE', 'openai', 'gpt-realtime-2.1',
   'VOICE_REALTIME_TEXT_CACHED_INPUT_TOKEN', 400000, 1000000, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","basis":"2026-09-20_openai_realtime_2_1"}'),
  ('VOICE', 'openai', 'gpt-realtime-2.1',
   'VOICE_REALTIME_TEXT_OUTPUT_TOKEN', 24000000, 1000000, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","basis":"2026-09-20_openai_realtime_2_1"}'),
  ('VOICE', 'openai', 'gpt-realtime-2.1-mini',
   'VOICE_REALTIME_AUDIO_INPUT_TOKEN', 10000000, 1000000, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","basis":"2026-09-20_openai_realtime_2_1_mini"}'),
  ('VOICE', 'openai', 'gpt-realtime-2.1-mini',
   'VOICE_REALTIME_AUDIO_CACHED_INPUT_TOKEN', 300000, 1000000, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","basis":"2026-09-20_openai_realtime_2_1_mini"}'),
  ('VOICE', 'openai', 'gpt-realtime-2.1-mini',
   'VOICE_REALTIME_AUDIO_OUTPUT_TOKEN', 20000000, 1000000, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","basis":"2026-09-20_openai_realtime_2_1_mini"}'),
  ('VOICE', 'openai', 'gpt-realtime-2.1-mini',
   'VOICE_REALTIME_TEXT_INPUT_TOKEN', 600000, 1000000, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","basis":"2026-09-20_openai_realtime_2_1_mini"}'),
  ('VOICE', 'openai', 'gpt-realtime-2.1-mini',
   'VOICE_REALTIME_TEXT_CACHED_INPUT_TOKEN', 60000, 1000000, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","basis":"2026-09-20_openai_realtime_2_1_mini"}'),
  ('VOICE', 'openai', 'gpt-realtime-2.1-mini',
   'VOICE_REALTIME_TEXT_OUTPUT_TOKEN', 2400000, 1000000, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","basis":"2026-09-20_openai_realtime_2_1_mini"}'),
  ('VOICE', 'telnyx', 'realtime-us-local',
   'VOICE_REALTIME_CARRIER_MINUTE', 5200, 1, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","market":"US","numberType":"local","basis":"voice_api_0.002_plus_inbound_sip_from_0.0032"}'),
  ('VOICE', 'telnyx', 'realtime-us-local',
   'VOICE_REALTIME_STREAM_MINUTE', 3500, 1, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","market":"US","numberType":"local","basis":"websocket_media_streaming"}'),
  ('VOICE', 'telnyx', 'realtime-us-local',
   'VOICE_REALTIME_RECORDING_MINUTE', 2000, 1, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","market":"US","numberType":"local","basis":"call_recording"}'),
  ('VOICE', 'telnyx', 'realtime-us-local',
   'VOICE_REALTIME_TRANSCRIPTION_MINUTE', 15000, 1, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","market":"US","numberType":"local","basis":"telnyx_stt_inbound_call_transcript"}'),
  ('VOICE', 'telnyx', 'realtime-us-local',
   'VOICE_REALTIME_GREETING_TTS_CHAR', 48, 1, 0, '2026-09-20T00:00:00Z', '{"currency":"USD","market":"US","numberType":"local","basis":"conservative_Telnyx_HD_TTS_proxy_for_configurable_greeting_voice_confirm_account_specific_Azure_rate"}')
ON CONFLICT DO NOTHING;
