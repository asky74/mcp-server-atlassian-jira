import { Logger } from './logger.util.js';
import { config } from './config.util.js';
import {
	createAuthInvalidError,
	createApiError,
	createUnexpectedError,
	createNotFoundError,
	McpError,
} from './error.util.js';
import { saveRawResponse } from './response.util.js';
import { Blob } from 'buffer';
import { request as httpsRequest } from 'https';

// Create a contextualized logger for this file
const transportLogger = Logger.forContext('utils/transport.util.ts');

// Log transport utility initialization
transportLogger.debug('Transport utility initialized');

/**
 * ЗАЧЕМ: в некоторых хост-процессах (наблюдалось в Claude Desktop/Claude Code
 * MCP-рантайме, 2026-07) глобальный fetch (undici) падает с
 * "TypeError: fetch failed" при живой сети — классический node:https стек в том
 * же процессе при этом работает. safeFetch() пробует штатный fetch и при таком
 * падении повторяет запрос через node:https, отдавая стандартный Response,
 * чтобы весь остальной код (text/arrayBuffer/headers) не менялся.
 * FORCE_HTTPS_FALLBACK=true — принудительно мимо undici (диагностика/аварийный рычаг).
 */
interface HttpsFallbackInit {
	method?: string;
	headers?: Record<string, string>;
	bodyBuffer?: Buffer;
}

function httpsFetch(
	url: string,
	init: HttpsFallbackInit,
	redirectsLeft = 5,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const req = httpsRequest(
			{
				hostname: u.hostname,
				port: u.port || 443,
				path: u.pathname + u.search,
				method: init.method || 'GET',
				headers: init.headers,
			},
			(res) => {
				const status = res.statusCode || 0;
				const location = res.headers.location;
				if (
					[301, 302, 303, 307, 308].includes(status) &&
					location &&
					redirectsLeft > 0
				) {
					res.resume();
					const next = new URL(location, url);
					const headers = { ...init.headers };
					// ЗАЧЕМ: как и fetch — не отдаём Basic-креды чужому хосту
					// (Jira редиректит контент вложений на media-CDN с подписанным URL)
					if (next.host !== u.host) {
						delete headers.Authorization;
					}
					let method = init.method;
					let bodyBuffer = init.bodyBuffer;
					if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
						method = 'GET';
						bodyBuffer = undefined;
					}
					resolve(
						httpsFetch(next.toString(), { method, headers, bodyBuffer }, redirectsLeft - 1),
					);
					return;
				}
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () => {
					const headers = new Headers();
					for (const [k, v] of Object.entries(res.headers)) {
						if (v !== undefined) {
							headers.set(k, Array.isArray(v) ? v.join(', ') : v);
						}
					}
					const noBody = status === 204 || status === 304;
					resolve(
						new Response(noBody ? null : Buffer.concat(chunks), {
							status,
							statusText: res.statusMessage || '',
							headers,
						}),
					);
				});
				res.on('error', reject);
			},
		);
		req.on('error', reject);
		if (init.bodyBuffer) {
			req.write(init.bodyBuffer);
		}
		req.end();
	});
}

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
	const force = process.env.FORCE_HTTPS_FALLBACK === 'true';
	if (!force) {
		try {
			return await fetch(url, init);
		} catch (error) {
			// Только сетевой отказ самого undici — HTTP-ошибки сюда не попадают
			// (fetch резолвится и на 4xx/5xx)
			if (!(error instanceof TypeError)) {
				throw error;
			}
			transportLogger.warn(
				`global fetch failed (${error.message}), retrying via node:https fallback`,
				{ url },
			);
		}
	}
	const headers = { ...(init.headers as Record<string, string>) };
	let bodyBuffer: Buffer | undefined;
	if (init.body instanceof FormData) {
		// ЗАЧЕМ: Response кодирует multipart/form-data (с boundary) без сети
		const encoded = new Response(init.body);
		bodyBuffer = Buffer.from(await encoded.arrayBuffer());
		const ct = encoded.headers.get('content-type');
		if (ct) {
			headers['Content-Type'] = ct;
		}
	} else if (typeof init.body === 'string') {
		bodyBuffer = Buffer.from(init.body);
	}
	if (bodyBuffer) {
		headers['Content-Length'] = String(bodyBuffer.length);
	}
	return httpsFetch(url, { method: init.method || 'GET', headers, bodyBuffer });
}

/**
 * Interface for Atlassian API credentials
 */
export interface AtlassianCredentials {
	siteName: string;
	userEmail: string;
	apiToken: string;
}

/**
 * Interface for HTTP request options
 */
export interface RequestOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	headers?: Record<string, string>;
	body?: unknown;
}

/**
 * Transport response wrapper that includes the data and the path to the raw response file
 */
export interface TransportResponse<T> {
	data: T;
	rawResponsePath: string | null;
}

/**
 * Get Atlassian credentials from environment variables
 * @returns AtlassianCredentials object or null if credentials are missing
 */
export function getAtlassianCredentials(): AtlassianCredentials | null {
	const methodLogger = Logger.forContext(
		'utils/transport.util.ts',
		'getAtlassianCredentials',
	);

	const siteName = config.get('ATLASSIAN_SITE_NAME');
	const userEmail = config.get('ATLASSIAN_USER_EMAIL');
	const apiToken = config.get('ATLASSIAN_API_TOKEN');

	if (!siteName || !userEmail || !apiToken) {
		methodLogger.warn(
			'Missing Atlassian credentials. Please set ATLASSIAN_SITE_NAME, ATLASSIAN_USER_EMAIL, and ATLASSIAN_API_TOKEN environment variables.',
		);
		return null;
	}

	methodLogger.debug('Using Atlassian credentials');
	return {
		siteName,
		userEmail,
		apiToken,
	};
}

/**
 * Fetch data from Atlassian API
 * @param credentials Atlassian API credentials
 * @param path API endpoint path (without base URL)
 * @param options Request options
 * @returns Transport response with data and raw response path
 */
export async function fetchAtlassian<T>(
	credentials: AtlassianCredentials,
	path: string,
	options: RequestOptions = {},
): Promise<TransportResponse<T>> {
	const methodLogger = Logger.forContext(
		'utils/transport.util.ts',
		'fetchAtlassian',
	);

	const { siteName, userEmail, apiToken } = credentials;

	// Ensure path starts with a slash
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;

	// Construct the full URL
	const baseUrl = `https://${siteName}.atlassian.net`;
	const url = `${baseUrl}${normalizedPath}`;

	// Set up authentication and headers
	const headers = {
		Authorization: `Basic ${Buffer.from(`${userEmail}:${apiToken}`).toString('base64')}`,
		'Content-Type': 'application/json',
		Accept: 'application/json',
		...options.headers,
	};

	// Prepare request options
	const requestOptions: RequestInit = {
		method: options.method || 'GET',
		headers,
		body: options.body ? JSON.stringify(options.body) : undefined,
	};

	methodLogger.debug(`Calling Atlassian API: ${url}`);

	// Track API call performance
	const startTime = performance.now();

	try {
		const response = await safeFetch(url, requestOptions);
		const endTime = performance.now();
		const requestDuration = (endTime - startTime).toFixed(2);

		// Log the raw response status and headers
		methodLogger.debug(
			`Raw response received: ${response.status} ${response.statusText}`,
			{
				url,
				status: response.status,
				statusText: response.statusText,
				// Just log a simplified representation of headers
				headers: {
					contentType: response.headers.get('content-type'),
					contentLength: response.headers.get('content-length'),
				},
			},
		);

		if (!response.ok) {
			const errorText = await response.text();
			methodLogger.error(
				`API error: ${response.status} ${response.statusText}`,
				{ errorText, url, method: options.method || 'GET' },
			);

			// Try to parse the error response - handle Jira-specific error formats
			let errorMessage = `${response.status} ${response.statusText}`;
			let parsedError = null;

			try {
				if (
					errorText &&
					(errorText.startsWith('{') || errorText.startsWith('['))
				) {
					parsedError = JSON.parse(errorText);

					// Process the parsed error object to build a comprehensive error message
					const errorParts: string[] = [];

					// Jira-specific error format: errorMessages array
					if (
						parsedError.errorMessages &&
						Array.isArray(parsedError.errorMessages) &&
						parsedError.errorMessages.length > 0
					) {
						// Format: {"errorMessages":["Issue does not exist or you do not have permission to see it."],"errors":{}}
						errorParts.push(parsedError.errorMessages.join('; '));
					}

					// Jira-specific error format: errors object with field-specific errors
					if (
						parsedError.errors &&
						typeof parsedError.errors === 'object' &&
						Object.keys(parsedError.errors).length > 0
					) {
						// Format: { "errors": { "jql": "The JQL query is invalid." }, "errorMessages": [], "warningMessages": [] }
						const fieldErrors = Object.entries(parsedError.errors)
							.map(([key, value]) => `${key}: ${value}`)
							.join('; ');
						errorParts.push(fieldErrors);
					}

					// Generic Atlassian API error with a message field
					if (parsedError.message) {
						// Format: {"message":"Some error message"}
						errorParts.push(parsedError.message);
					}

					// Other Atlassian API error formats (generic)
					if (
						parsedError.errors &&
						Array.isArray(parsedError.errors) &&
						parsedError.errors.length > 0
					) {
						// Format: {"errors":[{"status":400,"code":"INVALID_REQUEST_PARAMETER","title":"..."}]}
						const atlassianError = parsedError.errors[0];
						if (atlassianError.title) {
							errorParts.push(atlassianError.title);
						}
						if (atlassianError.detail) {
							errorParts.push(atlassianError.detail);
						}
					}

					// Check for warnings that might give additional context
					if (
						parsedError.warningMessages &&
						Array.isArray(parsedError.warningMessages) &&
						parsedError.warningMessages.length > 0
					) {
						errorParts.push(
							`Warnings: ${parsedError.warningMessages.join('; ')}`,
						);
					}

					// Combine all error parts into a single message
					if (errorParts.length > 0) {
						errorMessage = errorParts.join(' | ');
					}
				}
			} catch (parseError) {
				methodLogger.debug(`Error parsing error response:`, parseError);
				// Fall back to using the raw error text
				if (errorText && errorText.trim()) {
					errorMessage = errorText;
				}
			}

			// Classify HTTP errors based on status code
			if (response.status === 401) {
				throw createAuthInvalidError(
					`Authentication failed. Jira API: ${errorMessage}`,
					parsedError || errorText,
				);
			} else if (response.status === 403) {
				throw createAuthInvalidError(
					`Insufficient permissions. Jira API: ${errorMessage}`,
					parsedError || errorText,
				);
			} else if (response.status === 404) {
				throw createNotFoundError(
					`Resource not found. Jira API: ${errorMessage}`,
					parsedError || errorText,
				);
			} else if (response.status === 429) {
				throw createApiError(
					`Rate limit exceeded. Jira API: ${errorMessage}`,
					429,
					parsedError || errorText,
				);
			} else if (response.status >= 500) {
				throw createApiError(
					`Jira server error. Detail: ${errorMessage}`,
					response.status,
					parsedError || errorText,
				);
			} else {
				// For other API errors, create detailed error with context
				const requestPath = path.split('?')[0]; // Remove query parameters for cleaner logs
				let contextualInfo = '';

				// Add some contextual handling for common operations
				if (
					requestPath.includes('/search') &&
					parsedError?.errors?.jql
				) {
					contextualInfo = ' Check your JQL syntax for errors.';
				} else if (
					requestPath.includes('/issue/') &&
					options.method === 'POST'
				) {
					contextualInfo =
						' Check issue fields for validation errors.';
				}

				throw createApiError(
					`Jira API request failed. Detail: ${errorMessage}${contextualInfo}`,
					response.status,
					parsedError || errorText,
				);
			}
		}

		// Handle 204 No Content responses (common for DELETE operations)
		if (response.status === 204) {
			methodLogger.debug('Received 204 No Content response');
			return { data: {} as T, rawResponsePath: null };
		}

		// Handle binary/non-textual bodies (e.g. attachment content/thumbnail)
		// BEFORE reading as text: response.text() does lossy UTF-8 decoding and
		// irrecoverably corrupts non-UTF-8 bytes (PNG, etc. become mojibake).
		const contentType = response.headers.get('content-type') || '';
		const isTextual =
			contentType.includes('json') ||
			contentType.includes('text') ||
			contentType.includes('xml');
		if (!isTextual && contentType) {
			const arrayBuffer = await response.arrayBuffer();
			const base64 = Buffer.from(arrayBuffer).toString('base64');
			methodLogger.debug(
				`Received binary response (${contentType}, ${arrayBuffer.byteLength} bytes), base64-encoded`,
			);
			return {
				data: {
					__binary: true,
					contentType,
					byteLength: arrayBuffer.byteLength,
					base64,
				} as unknown as T,
				rawResponsePath: null,
			};
		}

		// Handle empty responses (some endpoints return 200/201 with no body)
		const responseText = await response.text();
		if (!responseText || responseText.trim() === '') {
			methodLogger.debug('Received empty response body');
			return { data: {} as T, rawResponsePath: null };
		}

		// For JSON responses, parse the text we already read
		try {
			const responseJson = JSON.parse(responseText);
			methodLogger.debug(`Response body:`, responseJson);

			// Save raw response to file and capture the path
			const rawResponsePath = saveRawResponse(
				url,
				requestOptions.method || 'GET',
				options.body,
				responseJson,
				response.status,
				parseFloat(requestDuration),
			);

			return { data: responseJson as T, rawResponsePath };
		} catch {
			methodLogger.debug(
				`Could not parse response as JSON, returning raw content`,
			);
			return {
				data: responseText as unknown as T,
				rawResponsePath: null,
			};
		}
	} catch (error) {
		methodLogger.error(`Request failed`, error);

		// If it's already an McpError, just rethrow it
		if (error instanceof McpError) {
			throw error;
		}

		// Handle network or parsing errors
		if (error instanceof TypeError && error.message.includes('fetch')) {
			throw createApiError(
				`Network error connecting to Jira API: ${error.message}`,
				500,
				error,
			);
		} else if (error instanceof SyntaxError) {
			throw createApiError(
				`Invalid response from Jira API (parsing error): ${error.message}`,
				500,
				error,
			);
		}

		throw createUnexpectedError(
			`Unexpected error while calling Jira API: ${error instanceof Error ? error.message : String(error)}`,
			error,
		);
	}
}

/**
 * Upload a file to Atlassian API using multipart/form-data
 * @param credentials Atlassian API credentials
 * @param path API endpoint path (without base URL)
 * @param fileBuffer The file content as a Buffer
 * @param fileName The name of the file
 * @param mimeType The MIME type of the file
 * @returns Transport response with data and raw response path
 */
export async function fetchAtlassianMultipart<T>(
	credentials: AtlassianCredentials,
	path: string,
	fileBuffer: Buffer,
	fileName: string,
	mimeType: string,
): Promise<TransportResponse<T>> {
	const methodLogger = Logger.forContext(
		'utils/transport.util.ts',
		'fetchAtlassianMultipart',
	);

	const { siteName, userEmail, apiToken } = credentials;

	// Ensure path starts with a slash
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;

	// Construct the full URL
	const baseUrl = `https://${siteName}.atlassian.net`;
	const url = `${baseUrl}${normalizedPath}`;

	// Create FormData and append the file
	const formData = new FormData();
	const blob = new Blob([fileBuffer], { type: mimeType });
	formData.append('file', blob, fileName);

	// Set up authentication and headers
	// Note: Content-Type is NOT set manually - fetch will set it with the boundary
	const headers: Record<string, string> = {
		Authorization: `Basic ${Buffer.from(`${userEmail}:${apiToken}`).toString('base64')}`,
		Accept: 'application/json',
		'X-Atlassian-Token': 'no-check', // Required for file uploads
	};

	methodLogger.debug(`Uploading file to Atlassian API: ${url}`, {
		fileName,
		mimeType,
		fileSize: fileBuffer.length,
	});

	const startTime = performance.now();

	try {
		const response = await safeFetch(url, {
			method: 'POST',
			headers,
			body: formData,
		});

		const endTime = performance.now();
		const requestDuration = (endTime - startTime).toFixed(2);

		methodLogger.debug(
			`Raw response received: ${response.status} ${response.statusText}`,
			{
				url,
				status: response.status,
				statusText: response.statusText,
			},
		);

		if (!response.ok) {
			const errorText = await response.text();
			methodLogger.error(
				`API error: ${response.status} ${response.statusText}`,
				{ errorText, url },
			);

			let errorMessage = `${response.status} ${response.statusText}`;
			let parsedError = null;

			try {
				if (
					errorText &&
					(errorText.startsWith('{') || errorText.startsWith('['))
				) {
					parsedError = JSON.parse(errorText);
					if (parsedError.errorMessages?.length > 0) {
						errorMessage = parsedError.errorMessages.join('; ');
					} else if (parsedError.message) {
						errorMessage = parsedError.message;
					}
				}
			} catch {
				if (errorText && errorText.trim()) {
					errorMessage = errorText;
				}
			}

			if (response.status === 401) {
				throw createAuthInvalidError(
					`Authentication failed. Jira API: ${errorMessage}`,
					parsedError || errorText,
				);
			} else if (response.status === 403) {
				throw createAuthInvalidError(
					`Insufficient permissions. Jira API: ${errorMessage}`,
					parsedError || errorText,
				);
			} else if (response.status === 404) {
				throw createNotFoundError(
					`Resource not found. Jira API: ${errorMessage}`,
					parsedError || errorText,
				);
			} else {
				throw createApiError(
					`Jira API request failed. Detail: ${errorMessage}`,
					response.status,
					parsedError || errorText,
				);
			}
		}

		const responseText = await response.text();
		if (!responseText || responseText.trim() === '') {
			return { data: {} as T, rawResponsePath: null };
		}

		try {
			const responseJson = JSON.parse(responseText);
			methodLogger.debug(`Response body:`, responseJson);

			const rawResponsePath = saveRawResponse(
				url,
				'POST',
				{ fileName, mimeType, fileSize: fileBuffer.length },
				responseJson,
				response.status,
				parseFloat(requestDuration),
			);

			return { data: responseJson as T, rawResponsePath };
		} catch {
			return {
				data: responseText as unknown as T,
				rawResponsePath: null,
			};
		}
	} catch (error) {
		methodLogger.error(`Request failed`, error);

		if (error instanceof McpError) {
			throw error;
		}

		if (error instanceof TypeError && error.message.includes('fetch')) {
			throw createApiError(
				`Network error connecting to Jira API: ${error.message}`,
				500,
				error,
			);
		}

		throw createUnexpectedError(
			`Unexpected error while uploading to Jira API: ${error instanceof Error ? error.message : String(error)}`,
			error,
		);
	}
}

/**
 * Fetch binary data from Atlassian API
 * @param credentials Atlassian API credentials
 * @param url Full URL to fetch (can be content URL from attachment metadata)
 * @returns Buffer containing the binary data
 */
export async function fetchAtlassianBinary(
	credentials: AtlassianCredentials,
	url: string,
): Promise<Buffer> {
	const methodLogger = Logger.forContext(
		'utils/transport.util.ts',
		'fetchAtlassianBinary',
	);

	const { userEmail, apiToken } = credentials;

	const headers = {
		Authorization: `Basic ${Buffer.from(`${userEmail}:${apiToken}`).toString('base64')}`,
	};

	methodLogger.debug(`Fetching binary data from: ${url}`);

	const startTime = performance.now();

	try {
		const response = await safeFetch(url, {
			method: 'GET',
			headers,
		});

		const endTime = performance.now();
		const requestDuration = (endTime - startTime).toFixed(2);

		methodLogger.debug(
			`Raw response received: ${response.status} ${response.statusText}`,
			{
				url,
				status: response.status,
				duration: `${requestDuration}ms`,
			},
		);

		if (!response.ok) {
			const errorText = await response.text();
			methodLogger.error(
				`API error: ${response.status} ${response.statusText}`,
				{ errorText, url },
			);

			const errorMessage = `${response.status} ${response.statusText}`;

			if (response.status === 401) {
				throw createAuthInvalidError(
					`Authentication failed. Jira API: ${errorMessage}`,
					errorText,
				);
			} else if (response.status === 403) {
				throw createAuthInvalidError(
					`Insufficient permissions. Jira API: ${errorMessage}`,
					errorText,
				);
			} else if (response.status === 404) {
				throw createNotFoundError(
					`Resource not found. Jira API: ${errorMessage}`,
					errorText,
				);
			} else {
				throw createApiError(
					`Jira API request failed. Detail: ${errorMessage}`,
					response.status,
					errorText,
				);
			}
		}

		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from(arrayBuffer);

		methodLogger.debug(`Downloaded ${buffer.length} bytes`);

		return buffer;
	} catch (error) {
		methodLogger.error(`Request failed`, error);

		if (error instanceof McpError) {
			throw error;
		}

		if (error instanceof TypeError && error.message.includes('fetch')) {
			throw createApiError(
				`Network error connecting to Jira API: ${error.message}`,
				500,
				error,
			);
		}

		throw createUnexpectedError(
			`Unexpected error while downloading from Jira API: ${error instanceof Error ? error.message : String(error)}`,
			error,
		);
	}
}
