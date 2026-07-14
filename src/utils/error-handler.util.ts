import { createApiError } from './error.util.js';
import { Logger } from './logger.util.js';

/**
 * Standard error codes for consistent handling
 */
export enum ErrorCode {
	NOT_FOUND = 'NOT_FOUND',
	INVALID_CURSOR = 'INVALID_CURSOR',
	ACCESS_DENIED = 'ACCESS_DENIED',
	VALIDATION_ERROR = 'VALIDATION_ERROR',
	UNEXPECTED_ERROR = 'UNEXPECTED_ERROR',
	NETWORK_ERROR = 'NETWORK_ERROR',
	RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
	JIRA_JQL_ERROR = 'JIRA_JQL_ERROR',
	JIRA_FIELD_VALIDATION_ERROR = 'JIRA_FIELD_VALIDATION_ERROR',
	JIRA_RESOURCE_LOCKED = 'JIRA_RESOURCE_LOCKED',
}

/**
 * Context information for error handling
 */
export interface ErrorContext {
	/**
	 * Source of the error (e.g., file path and function)
	 */
	source?: string;

	/**
	 * Type of entity being processed (e.g., 'Project', 'Issue')
	 */
	entityType?: string;

	/**
	 * Identifier of the entity being processed
	 */
	entityId?: string | Record<string, string>;

	/**
	 * Operation being performed (e.g., 'listing', 'creating')
	 */
	operation?: string;

	/**
	 * Additional information for debugging
	 */
	additionalInfo?: Record<string, unknown>;
}

/**
 * Helper function to create a consistent error context object
 * @param entityType Type of entity being processed
 * @param operation Operation being performed
 * @param source Source of the error (typically file path and function)
 * @param entityId Optional identifier of the entity
 * @param additionalInfo Optional additional information for debugging
 * @returns A formatted ErrorContext object
 */
export function buildErrorContext(
	entityType: string,
	operation: string,
	source: string,
	entityId?: string | Record<string, string>,
	additionalInfo?: Record<string, unknown>,
): ErrorContext {
	return {
		entityType,
		operation,
		source,
		...(entityId && { entityId }),
		...(additionalInfo && { additionalInfo }),
	};
}

/**
 * Detect specific error types from raw errors
 * @param error The error to analyze
 * @param context Context information for better error detection
 * @returns Object containing the error code and status code
 */
export function detectErrorType(
	error: unknown,
	context: ErrorContext = {},
): { code: ErrorCode; statusCode: number } {
	const methodLogger = Logger.forContext(
		'utils/error-handler.util.ts',
		'detectErrorType',
	);
	methodLogger.debug(`Detecting error type`, { error, context });

	const errorMessage = error instanceof Error ? error.message : String(error);
	const statusCode =
		error instanceof Error && 'statusCode' in error
			? (error as { statusCode: number }).statusCode
			: undefined;

	// Network error detection
	if (
		errorMessage.includes('network error') ||
		errorMessage.includes('fetch failed') ||
		errorMessage.includes('ECONNREFUSED') ||
		errorMessage.includes('ENOTFOUND') ||
		errorMessage.includes('Failed to fetch') ||
		errorMessage.includes('Network request failed')
	) {
		return { code: ErrorCode.NETWORK_ERROR, statusCode: 500 };
	}

	// Rate limiting detection
	if (
		errorMessage.includes('rate limit') ||
		errorMessage.includes('too many requests') ||
		statusCode === 429
	) {
		return { code: ErrorCode.RATE_LIMIT_ERROR, statusCode: 429 };
	}

	// Jira-specific JQL error detection
	if (
		errorMessage.includes('Error in the JQL Query') ||
		errorMessage.includes('The JQL query is invalid') ||
		(errorMessage.includes('JQL') &&
			(errorMessage.includes('syntax') ||
				errorMessage.includes('parse error') ||
				errorMessage.includes('invalid')))
	) {
		return { code: ErrorCode.JIRA_JQL_ERROR, statusCode: 400 };
	}

	// Jira-specific field validation error detection
	if (
		errorMessage.includes('Field') &&
		(errorMessage.includes('operation') ||
			errorMessage.includes('not found') ||
			errorMessage.includes('required') ||
			errorMessage.includes('invalid'))
	) {
		return { code: ErrorCode.JIRA_FIELD_VALIDATION_ERROR, statusCode: 400 };
	}

	// Jira resource locked
	if (
		errorMessage.includes('issue is locked') ||
		errorMessage.includes('currently being edited') ||
		errorMessage.includes('in use by another user')
	) {
		return { code: ErrorCode.JIRA_RESOURCE_LOCKED, statusCode: 409 };
	}

	// Check for Jira-specific error objects in originalError
	if (
		error instanceof Error &&
		'originalError' in error &&
		error.originalError
	) {
		// Try to parse originalError for Jira-specific patterns
		try {
			const originalError =
				typeof error.originalError === 'string'
					? JSON.parse(error.originalError)
					: error.originalError;

			if (typeof originalError === 'object') {
				// Check for Jira errorMessages array
				if (
					originalError.errorMessages &&
					Array.isArray(originalError.errorMessages)
				) {
					const errorMessages = originalError.errorMessages.join(' ');

					if (errorMessages.includes('JQL')) {
						return {
							code: ErrorCode.JIRA_JQL_ERROR,
							statusCode: 400,
						};
					}

					if (errorMessages.includes('Field')) {
						return {
							code: ErrorCode.JIRA_FIELD_VALIDATION_ERROR,
							statusCode: 400,
						};
					}
				}

				// Check for Jira errors object with field-specific errors
				if (
					originalError.errors &&
					typeof originalError.errors === 'object'
				) {
					const fieldErrors = Object.keys(originalError.errors);

					if (fieldErrors.includes('jql')) {
						return {
							code: ErrorCode.JIRA_JQL_ERROR,
							statusCode: 400,
						};
					}

					// If there are field errors, classify as field validation error
					if (fieldErrors.length > 0) {
						return {
							code: ErrorCode.JIRA_FIELD_VALIDATION_ERROR,
							statusCode: 400,
						};
					}
				}
			}
		} catch (e) {
			// If we can't parse the originalError, continue with other checks
			methodLogger.debug(
				'Failed to parse originalError for Jira-specific patterns',
				e,
			);
		}
	}

	// Not Found detection
	if (
		errorMessage.includes('not found') ||
		errorMessage.includes('does not exist') ||
		statusCode === 404
	) {
		return { code: ErrorCode.NOT_FOUND, statusCode: 404 };
	}

	// Access Denied detection
	if (
		errorMessage.includes('access') ||
		errorMessage.includes('permission') ||
		errorMessage.includes('authorize') ||
		errorMessage.includes('authentication') ||
		statusCode === 401 ||
		statusCode === 403
	) {
		return { code: ErrorCode.ACCESS_DENIED, statusCode: statusCode || 403 };
	}

	// Invalid Cursor detection
	if (
		(errorMessage.includes('cursor') ||
			errorMessage.includes('startAt') ||
			errorMessage.includes('page')) &&
		(errorMessage.includes('invalid') || errorMessage.includes('not valid'))
	) {
		return { code: ErrorCode.INVALID_CURSOR, statusCode: 400 };
	}

	// Validation Error detection
	if (
		errorMessage.includes('validation') ||
		errorMessage.includes('invalid') ||
		errorMessage.includes('required') ||
		statusCode === 400 ||
		statusCode === 422
	) {
		return {
			code: ErrorCode.VALIDATION_ERROR,
			statusCode: statusCode || 400,
		};
	}

	// Default to unexpected error
	return {
		code: ErrorCode.UNEXPECTED_ERROR,
		statusCode: statusCode || 500,
	};
}

/**
 * Create user-friendly error messages based on error type and context
 * @param code The error code
 * @param context Context information for better error messages
 * @param originalMessage The original error message
 * @returns User-friendly error message
 */
export function createUserFriendlyErrorMessage(
	code: ErrorCode,
	context: ErrorContext = {},
	originalMessage?: string,
): string {
	const methodLogger = Logger.forContext(
		'utils/error-handler.util.ts',
		'createUserFriendlyErrorMessage',
	);
	const { entityType, entityId, operation } = context;

	// Format entity ID for display
	let entityIdStr = '';
	if (entityId) {
		if (typeof entityId === 'string') {
			entityIdStr = entityId;
		} else {
			// Handle object entityId (like ProjectIdentifier)
			entityIdStr = Object.values(entityId).join('/');
		}
	}

	// Determine entity display name
	const entity = entityType
		? `${entityType}${entityIdStr ? ` ${entityIdStr}` : ''}`
		: 'Resource';

	let message = '';

	switch (code) {
		case ErrorCode.NOT_FOUND:
			message = `${entity} not found${entityIdStr ? `: ${entityIdStr}` : ''}. Verify the ID is correct and that you have access to this ${entityType?.toLowerCase() || 'resource'}.`;
			break;

		case ErrorCode.ACCESS_DENIED:
			message = `Access denied for ${entity.toLowerCase()}${entityIdStr ? ` ${entityIdStr}` : ''}. Verify your credentials and permissions.`;
			break;

		case ErrorCode.INVALID_CURSOR:
			message = `Invalid pagination cursor. Use the exact cursor string returned from previous results.`;
			break;

		case ErrorCode.VALIDATION_ERROR:
			message =
				originalMessage ||
				`Invalid data provided for ${operation || 'operation'} ${entity.toLowerCase()}.`;
			break;

		case ErrorCode.NETWORK_ERROR:
			message = `Network error while ${operation || 'connecting to'} Jira. Please check your internet connection and try again.`;
			break;

		case ErrorCode.RATE_LIMIT_ERROR:
			message = `Rate limit exceeded. Please wait a moment and try again, or reduce the frequency of requests to the Jira API.`;
			break;

		case ErrorCode.JIRA_JQL_ERROR:
			message = `Invalid JQL query${entityIdStr ? ` for ${entityIdStr}` : ''}. Please check your syntax and verify that all field names are valid.`;
			if (originalMessage) {
				message += ` Error details: ${originalMessage}`;
			}
			message +=
				' Note: JQL functions relying on user context (like currentUser()) may not work with API token authentication.';
			break;

		case ErrorCode.JIRA_FIELD_VALIDATION_ERROR:
			message = `Field validation error${entityIdStr ? ` for ${entityIdStr}` : ''}. ${originalMessage || 'One or more fields contain invalid data.'}`;
			break;

		case ErrorCode.JIRA_RESOURCE_LOCKED:
			message = `The ${entityType?.toLowerCase() || 'resource'} is currently locked or being edited by another user. Please try again later.`;
			break;

		default:
			message = `An unexpected error occurred while ${operation || 'processing'} ${entity.toLowerCase()}.`;
	}

	// Include original message details if appropriate and not already included
	if (
		originalMessage &&
		code !== ErrorCode.NOT_FOUND &&
		code !== ErrorCode.ACCESS_DENIED &&
		code !== ErrorCode.JIRA_JQL_ERROR && // Skip for JQL errors as we handled it specially
		!message.includes(originalMessage)
	) {
		message += ` Error details: ${originalMessage}`;
	}

	methodLogger.debug(`Created user-friendly message: ${message}`, {
		code,
		context,
	});
	return message;
}

/**
 * Handle controller errors consistently
 * @param error The error to handle
 * @param context Context information for better error messages
 * @returns Never returns, always throws an error
 */
export function handleControllerError(
	error: unknown,
	context: ErrorContext = {},
): never {
	const methodLogger = Logger.forContext(
		'utils/error-handler.util.ts',
		'handleControllerError',
	);

	// Extract error details
	const errorMessage = error instanceof Error ? error.message : String(error);
	const statusCode =
		error instanceof Error && 'statusCode' in error
			? (error as { statusCode: number }).statusCode
			: undefined;

	// Detect error type using utility
	const { code, statusCode: detectedStatus } = detectErrorType(
		error,
		context,
	);

	// Combine detected status with explicit status
	const finalStatusCode = statusCode || detectedStatus;

	// Format entity information for logging
	const { entityType, entityId, operation } = context;
	const entity = entityType || 'resource';
	const entityIdStr = entityId
		? typeof entityId === 'string'
			? entityId
			: JSON.stringify(entityId)
		: '';
	const actionStr = operation || 'processing';

	// Log detailed error information
	methodLogger.error(
		`Error ${actionStr} ${entity}${
			entityIdStr ? `: ${entityIdStr}` : ''
		}: ${errorMessage}`,
		error,
	);

	// Create user-friendly error message for the response
	const message =
		code === ErrorCode.VALIDATION_ERROR ||
		code === ErrorCode.JIRA_JQL_ERROR ||
		code === ErrorCode.JIRA_FIELD_VALIDATION_ERROR
			? errorMessage // Use original message for validation errors
			: createUserFriendlyErrorMessage(code, context, errorMessage);

	// Throw an appropriate API error with the user-friendly message
	throw createApiError(message, finalStatusCode, error);
}
