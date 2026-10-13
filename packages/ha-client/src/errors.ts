/**
 * Error codes raised by the client itself. Requests that Home Assistant rejects carry Home
 * Assistant's own code instead (for example `not_found`, `unauthorized`, `invalid_format`,
 * `home_assistant_error` or `service_validation_error`).
 */
export type ClientErrorCode =
  | 'invalid_url'
  | 'invalid_token'
  | 'auth_invalid'
  | 'not_connected'
  | 'not_authenticated'
  | 'timeout'
  | 'connection_lost'
  | 'aborted';

export class HomeAssistantError extends Error {
  readonly code: ClientErrorCode | (string & {});
  readonly details: unknown;

  constructor(message: string, code: ClientErrorCode | (string & {}), details?: unknown) {
    super(message);
    this.name = 'HomeAssistantError';
    this.code = code;
    this.details = details;
  }
}
