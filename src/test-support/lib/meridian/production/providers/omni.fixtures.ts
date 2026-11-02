/**
 * Google Interactions API REST Fixtures for Gemini Omni
 *
 * Implements Section P1-D: Representative fixtures derived from official
 * REST API response schemas for video synthesis and artifact materialization.
 */

export const OMNI_FIXTURE_COMPLETED_BASE64 = {
  interaction_id: "interactions/int-completed-456",
  status: "completed",
  steps: [
    {
      type: "model_output",
      content: [
        {
          type: "text",
          text: "Here is your generated video.",
        },
        {
          type: "video",
          mime_type: "video/mp4",
          data: "AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29tYXZjMQAAADFtb292AAAAbG12aGQ=", // MP4 test header
        },
      ],
    },
  ],
};

export const OMNI_FIXTURE_IN_PROGRESS = {
  interaction_id: "interactions/int-running-789",
  status: "in_progress",
  steps: [],
};

export const OMNI_FIXTURE_TEXT_ONLY = {
  interaction_id: "interactions/int-text-only-101",
  status: "completed",
  steps: [
    {
      type: "model_output",
      content: [
        {
          type: "text",
          text: "I cannot generate this video because the prompt violated safety guidelines.",
        },
      ],
    },
  ],
};

export const OMNI_FIXTURE_MALFORMED = {
  interaction_id: "interactions/int-malformed",
  status: "unknown_status",
  steps: [
    {
      type: "unexpected_step",
    },
  ],
};

export const OMNI_FIXTURE_REMOTE_URI = {
  interaction_id: "interactions/int-remote-uri-202",
  status: "completed",
  steps: [
    {
      type: "model_output",
      content: [
        {
          type: "video",
          mime_type: "video/mp4",
          uri: "https://storage.googleapis.com/test-artifacts/output.mp4",
        },
      ],
    },
  ],
};
