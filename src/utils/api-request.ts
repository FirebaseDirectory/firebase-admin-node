/*!
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {deepCopy} from './deep-copy';
import {FirebaseApp} from '../firebase-app';
import {AppErrorCodes, FirebaseAppError} from './error';

import https = require('https');

/** Http method type definition. */
export type HttpMethod = 'GET' | 'POST';
/** API callback function type definition. */
export type ApiCallbackFunction = (data: Object) => void;

/**
 * Base class for handling HTTP requests.
 */
export class HttpRequestHandler {
  /**
   * Sends HTTP requests and returns a promise that resolves with the result.
   *
   * @param {string} host The HTTP host.
   * @param {number} port The port number.
   * @param {string} path The endpoint path.
   * @param {HttpMethod} httpMethod The http method.
   * @param {Object} [data] The request JSON.
   * @param {Object} [headers] The request headers.
   * @param {number} [timeout] The request timeout in milliseconds.
   * @return {Promise<Object>} A promise that resolves with the response.
   */
  public sendRequest(
      host: string,
      port: number,
      path: string,
      httpMethod: HttpMethod,
      data?: Object,
      headers?: Object,
      timeout?: number): Promise<Object> {
    let requestData;
    if (data) {
      try {
        requestData = JSON.stringify(data);
      } catch (e) {
        return Promise.reject(e);
      }
    }
    const options = {
      method: httpMethod,
      host,
      port,
      path,
      headers,
    };
    // Only https endpoints.
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        if (this.isDebugEnabled()) {
          this.logDebug(
            `[HTTP_RESP] ${res.socket.localAddress}/${res.socket.localPort} ` +
            `https://${res.req.method} ${res.socket._host}${res.req.path} ` +
            `${res.statusCode} ${res.statusMessage}`);
        }
        let buffers: Buffer[] = [];
        res.on('data', (buffer: Buffer) => buffers.push(buffer));
        res.on('end', () => {
          const response = Buffer.concat(buffers).toString();

          const statusCode = res.statusCode || 200;

          const responseHeaders = res.headers || {};
          const contentType = responseHeaders['content-type'] || 'application/json';

          if (contentType.indexOf('text/html') !== -1 || contentType.indexOf('text/plain') !== -1) {
            // Text response
            if (statusCode >= 200 && statusCode < 300) {
              resolve(response);
            } else {
              reject({
                statusCode,
                error: response,
              });
            }
          } else {
            // JSON response
            try {
              const json = JSON.parse(response);

              if (statusCode >= 200 && statusCode < 300) {
                resolve(json);
              } else {
                reject({
                  statusCode,
                  error: json,
                });
              }
            } catch (error) {
              const parsingError = new FirebaseAppError(
                AppErrorCodes.UNABLE_TO_PARSE_RESPONSE,
                `Failed to parse response data: "${ error.toString() }". Raw server` +
                `response: "${ response }". Status code: "${ res.statusCode }". Outgoing ` +
                `request: "${ options.method } ${options.host}${ options.path }"`,
              );
              reject({
                statusCode,
                error: parsingError,
              });
            }
          }
        });
      });

      if (this.isDebugEnabled()) {
        req.on('socket', (socket) => {
          socket.on('connect', () => {
            this.logDebug(
              `[CONN_OPEN] ${socket.localAddress}/${socket.localPort} -> ` + 
              `${socket._host} (${socket.remoteAddress}/${socket.remotePort})`);
            socket._ctx_local = `${socket.localAddress}/${socket.localPort}`;
          });
          socket.on('close', (hasError) => {
            this.logDebug(
              `[CONN_CLOSE] ${socket._ctx_local} -> ` +
              `${socket._host} (${socket.remoteAddress}/${socket.remotePort})`);
              socket._ctx_local = null;
          });
        });
      }

      if (timeout) {
        // Listen to timeouts and throw a network error.
        req.on('socket', (socket) => {
          socket.setTimeout(timeout);
          socket.on('timeout', () => {
            this.logDebug(
              `[CONN_TIMEOUT] ${socket._ctx_local} -> ${socket._host} ` +
              `(${socket.remoteAddress}/${socket.remotePort})`);
            req.abort();

            const networkTimeoutError = new FirebaseAppError(
              AppErrorCodes.NETWORK_TIMEOUT,
              `${ host } network timeout. Please try again.`,
            );
            reject({
              statusCode: 408,
              error: networkTimeoutError,
            });
          });
        });
      }

      req.on('error', (error) => {
        const networkRequestError = new FirebaseAppError(
          AppErrorCodes.NETWORK_ERROR,
          `A network request error has occurred: ${ error && error.message }`,
        );
        reject({
          statusCode: 502,
          error: networkRequestError,
        });
      });

      if (requestData) {
        req.write(requestData);
      }

      req.end();
    });
  }

  protected isDebugEnabled(): boolean {
    return false;
  }

  private logDebug(message: string): void {
    console.log(`${new Date().toISOString()} ${message}`);
  }
}

/**
 * Class that extends HttpRequestHandler and signs HTTP requests with a service
 * credential access token.
 *
 * @param {Credential} credential The service account credential used to
 *     sign HTTP requests.
 * @constructor
 */
export class SignedApiRequestHandler extends HttpRequestHandler {
  constructor(private app_: FirebaseApp) {
    super();
  }

  /**
   * Sends HTTP requests and returns a promise that resolves with the result.
   *
   * @param {string} host The HTTP host.
   * @param {number} port The port number.
   * @param {string} path The endpoint path.
   * @param {HttpMethod} httpMethod The http method.
   * @param {Object} data The request JSON.
   * @param {Object} headers The request headers.
   * @param {number} timeout The request timeout in milliseconds.
   * @return {Promise} A promise that resolves with the response.
   */
  public sendRequest(
      host: string,
      port: number,
      path: string,
      httpMethod: HttpMethod,
      data: Object,
      headers: Object,
      timeout: number): Promise<Object> {
    return this.app_.INTERNAL.getToken().then((accessTokenObj) => {
      let headersCopy: Object = deepCopy(headers);
      let authorizationHeaderKey = 'Authorization';
      headersCopy[authorizationHeaderKey] = 'Bearer ' + accessTokenObj.accessToken;
      return super.sendRequest(host, port, path, httpMethod, data, headersCopy, timeout);
    });
  }

  protected isDebugEnabled(): boolean {
    return this.app_.options.httpDebug === true;
  }
}

/**
 * Class that defines all the settings for the backend API endpoint.
 *
 * @param {string} endpoint The Firebase Auth backend endpoint.
 * @param {HttpMethod} httpMethod The http method for that endpoint.
 * @constructor
 */
export class ApiSettings {
  private requestValidator: ApiCallbackFunction;
  private responseValidator: ApiCallbackFunction;

  constructor(private endpoint: string, private httpMethod: HttpMethod = 'POST') {
    this.setRequestValidator(null)
        .setResponseValidator(null);
  }

  /** @return {string} The backend API endpoint. */
  public getEndpoint(): string {
    return this.endpoint;
  }

  /** @return {HttpMethod} The request HTTP method. */
  public getHttpMethod(): HttpMethod {
    return this.httpMethod;
  }

  /**
   * @param {ApiCallbackFunction} requestValidator The request validator.
   * @return {ApiSettings} The current API settings instance.
   */
  public setRequestValidator(requestValidator: ApiCallbackFunction): ApiSettings {
    let nullFunction = (request: Object) => undefined;
    this.requestValidator = requestValidator || nullFunction;
    return this;
  }

  /** @return {ApiCallbackFunction} The request validator. */
  public getRequestValidator(): ApiCallbackFunction {
    return this.requestValidator;
  }

  /**
   * @param {ApiCallbackFunction} responseValidator The response validator.
   * @return {ApiSettings} The current API settings instance.
   */
  public setResponseValidator(responseValidator: ApiCallbackFunction): ApiSettings {
    let nullFunction = (request: Object) => undefined;
    this.responseValidator = responseValidator || nullFunction;
    return this;
  }

  /** @return {ApiCallbackFunction} The response validator. */
  public getResponseValidator(): ApiCallbackFunction {
    return this.responseValidator;
  }
}
