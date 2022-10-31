import tl = require('azure-pipelines-task-lib/task');
import Q = require('q');
import querystring = require('querystring');
import webClient = require("./webClient");
import AzureModels = require("./azureModels");
import constants = require('./constants');
import path = require('path');
import fs = require('fs');
import jwt = require('jsonwebtoken');
import msal = require('@azure/msal-node');
import forge = require('node-forge');

tl.setResourcePath(path.join(__dirname, 'module.json'), true);

export class ApplicationTokenCredentials {
    public baseUrl: string;
    public authorityUrl: string;
    public activeDirectoryResourceId: string;
    public isAzureStackEnvironment: boolean;
    public scheme: number;
    public msiClientId: string;

    private clientId: string;
    private domain: string;
    private authType: string;
    private secret?: string;
    private accessToken?: string;
    private certFilePath?: string;
    private isADFSEnabled?: boolean;
    private token_deferred: Q.Promise<string>;
    private useMSAL: boolean;
    private msalInstance: msal.ConfidentialClientApplication;

    constructor(clientId: string, domain: string, secret: string, baseUrl: string, authorityUrl: string, activeDirectoryResourceId: string, isAzureStackEnvironment: boolean, scheme?: string, msiClientId?: string, authType?: string, certFilePath?: string, isADFSEnabled?: boolean, access_token?: string, useMSAL: boolean = false) {

        if (!Boolean(domain) || typeof domain.valueOf() !== 'string') {
            throw new Error(tl.loc("DomainCannotBeEmpty"));
        }

        if ((!scheme || scheme === 'ServicePrincipal')) {
            if (!Boolean(clientId) || typeof clientId.valueOf() !== 'string') {
                throw new Error(tl.loc("ClientIdCannotBeEmpty"));
            }

            if (!authType || authType == constants.AzureServicePrinicipalAuthentications.servicePrincipalKey) {
                if (!Boolean(secret) || typeof secret.valueOf() !== 'string') {
                    throw new Error(tl.loc("SecretCannotBeEmpty"));
                }
            }
            else {
                if (!Boolean(certFilePath) || typeof certFilePath.valueOf() !== 'string') {
                    throw new Error(tl.loc("InvalidCertFileProvided"));
                }
            }

        }

        if (!Boolean(baseUrl) || typeof baseUrl.valueOf() !== 'string') {
            throw new Error(tl.loc("armUrlCannotBeEmpty"));
        }

        if (!Boolean(authorityUrl) || typeof authorityUrl.valueOf() !== 'string') {
            throw new Error(tl.loc("authorityUrlCannotBeEmpty"));
        }

        if (!Boolean(activeDirectoryResourceId) || typeof activeDirectoryResourceId.valueOf() !== 'string') {
            throw new Error(tl.loc("activeDirectoryResourceIdUrlCannotBeEmpty"));
        }

        if (!Boolean(isAzureStackEnvironment) || typeof isAzureStackEnvironment.valueOf() != 'boolean') {
            isAzureStackEnvironment = false;
        }

        this.clientId = clientId;
        this.domain = domain;
        this.baseUrl = baseUrl;
        this.authorityUrl = authorityUrl;
        this.activeDirectoryResourceId = activeDirectoryResourceId;
        this.isAzureStackEnvironment = isAzureStackEnvironment;

        this.scheme = scheme ? AzureModels.Scheme[scheme] : AzureModels.Scheme['ServicePrincipal'];
        this.msiClientId = msiClientId;
        if (this.scheme == AzureModels.Scheme['ServicePrincipal']) {
            this.authType = authType ? authType : constants.AzureServicePrinicipalAuthentications.servicePrincipalKey;
            if (this.authType == constants.AzureServicePrinicipalAuthentications.servicePrincipalKey) {
                this.secret = secret;
            }
            else {
                this.certFilePath = certFilePath;
            }
        }

        this.isADFSEnabled = isADFSEnabled;
        this.accessToken = access_token;

        this.useMSAL = useMSAL;
    }

    // TODO: in progress
    public static getMSIAuthorizationToken(retyCount: number, timeToWait: number, baseUrl: string, msiClientId?: string): Q.Promise<string> {
        var deferred = Q.defer<string>();
        let webRequest = new webClient.WebRequest();
        webRequest.method = "GET";
        let apiVersion = "2018-02-01";
        const retryLimit = 5;
        msiClientId = msiClientId ? "&client_id=" + msiClientId : "";
        webRequest.uri = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=" + apiVersion + "&resource=" + baseUrl + msiClientId;
        webRequest.headers = {
            "Metadata": true
        };

        webClient.sendRequest(webRequest).then(
            (response: webClient.WebResponse) => {
                if (response.statusCode == 200) {
                    deferred.resolve(response.body.access_token);
                }
                else if (response.statusCode == 429 || response.statusCode == 500) {
                    if (retyCount < retryLimit) {
                        let waitedTime = 2000 + timeToWait * 2;
                        retyCount += 1;
                        setTimeout(() => {
                            deferred.resolve(this.getMSIAuthorizationToken(retyCount, waitedTime, baseUrl, msiClientId));
                        }, waitedTime);
                    }
                    else {
                        deferred.reject(tl.loc('CouldNotFetchAccessTokenforMSIStatusCode', response.statusCode, response.statusMessage));
                    }

                }
                else {
                    deferred.reject(tl.loc('CouldNotFetchAccessTokenforMSIDueToMSINotConfiguredProperlyStatusCode', response.statusCode, response.statusMessage));
                }
            },
            (error) => {
                deferred.reject(error)
            }
        );

        return deferred.promise;
    }

    public getDomain(): string {
        return this.domain;
    }

    public getClientId(): string {
        return this.clientId;
    }

    public getToken(force?: boolean, useMSAL: boolean = false): Q.Promise<string> {
        return useMSAL ? this.getMSALToken(force) : this.getADALToken(force);
    }

    private buildMSAL(): void {
        if (!this.msalInstance) {
            const msalConfig: msal.Configuration = {
                auth: {
                    clientId: this.clientId,
                    authority: this.authorityUrl + this.domain,
                },
                system: {
                    loggerOptions: {
                        loggerCallback(loglevel, message, containsPii) {
                            tl.debug(message);
                        },
                        piiLoggingEnabled: false,
                        logLevel: msal.LogLevel.Info,
                    }
                }
            };

            if (this.authType == constants.AzureServicePrinicipalAuthentications.servicePrincipalKey) {
                msalConfig.auth.clientSecret = this.secret;
            } else {
                const certificate = fs.readFileSync(this.certFilePath);

                // thumbprint
                const md = forge.md.sha1.create();
                md.update(forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes());
                const thumbprint = md.digest().toHex();

                // privatekey
                const privateKey = forge.pki.privateKeyFromPem(certificate);

                msalConfig.auth.clientCertificate.thumbprint = thumbprint;
                msalConfig.auth.clientCertificate.privateKey = privateKey;
            }

            this.msalInstance = new msal.ConfidentialClientApplication(msalConfig);
        }
    }

    private getMSALToken(force?: boolean): Q.Promise<string> {
        this.buildMSAL();

        let tokenDeferred = Q.defer<string>();

        let request: msal.ClientCredentialRequest = {
            scopes: [this.activeDirectoryResourceId + "/.default"]
        };

        let authResult = this.msalInstance.acquireTokenByClientCredential(request);

        authResult.then(
            (response: msal.AuthenticationResult) => {
                tokenDeferred.resolve(response.accessToken);
            }).catch((error) => {
                tokenDeferred.reject(tl.loc('CouldNotFetchAccessTokenforAzureStatusCode', error.statusCode, error.statusMessage));
            });

        return tokenDeferred.promise;
    }

    /**
     * @deprecated ADAL related methods are deprecated and will be removed. 
     * Use Use `getMSALToken(force?: boolean)` instead.
     */
    private getADALToken(force?: boolean): Q.Promise<string> {
        if (!!this.accessToken && !force) {
            tl.debug("==================== USING ENDPOINT PROVIDED ACCESS TOKEN ====================");
            let deferred = Q.defer<string>();
            deferred.resolve(this.accessToken);
            return deferred.promise;
        }

        if (!this.token_deferred || force) {
            if (this.scheme === AzureModels.Scheme.ManagedServiceIdentity) {
                this.token_deferred = ApplicationTokenCredentials.getMSIAuthorizationToken(0, 0, this.baseUrl, this.msiClientId);
            }
            else {
                this.token_deferred = this._getSPNAuthorizationToken();
            }
        }

        return this.token_deferred;
    }

    /**
     * @deprecated ADAL related methods are deprecated and will be removed. 
     * Use Use `getMSALToken(force?: boolean)` instead.
     */
    private _getSPNAuthorizationToken(): Q.Promise<string> {
        if (this.authType == constants.AzureServicePrinicipalAuthentications.servicePrincipalKey) {
            return this._getSPNAuthorizationTokenFromKey();
        }

        return this._getSPNAuthorizationTokenFromCertificate()
    }

    /**
     * @deprecated ADAL related methods are deprecated and will be removed. 
     * Use Use `getMSALToken(force?: boolean)` instead.
     */
    private _getSPNAuthorizationTokenFromCertificate(): Q.Promise<string> {
        var deferred = Q.defer<string>();
        let webRequest = new webClient.WebRequest();
        webRequest.method = "POST";
        webRequest.uri = this.authorityUrl + (this.isADFSEnabled ? "" : this.domain) + "/oauth2/token/";
        webRequest.body = querystring.stringify({
            resource: this.activeDirectoryResourceId,
            client_id: this.clientId,
            grant_type: "client_credentials",
            client_assertion: this._getSPNCertificateAuthorizationToken(),
            client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
        });

        let webRequestOptions: webClient.WebRequestOptions = {
            retriableErrorCodes: null,
            retriableStatusCodes: [400, 408, 409, 500, 502, 503, 504],
            retryCount: null,
            retryIntervalInSeconds: null,
            retryRequestTimedout: null
        };

        webClient.sendRequest(webRequest, webRequestOptions).then(
            (response: webClient.WebResponse) => {
                if (response.statusCode == 200) {
                    deferred.resolve(response.body.access_token);
                }
                else if ([400, 401, 403].indexOf(response.statusCode) != -1) {
                    deferred.reject(tl.loc('ExpiredServicePrincipal'));
                }
                else {
                    deferred.reject(tl.loc('CouldNotFetchAccessTokenforAzureStatusCode', response.statusCode, response.statusMessage));
                }
            },
            (error) => {
                deferred.reject(error)
            }
        );
        return deferred.promise;
    }

    /**
     * @deprecated ADAL related methods are deprecated and will be removed. 
     * Use Use `getMSALToken(force?: boolean)` instead.
     */
    private _getSPNAuthorizationTokenFromKey(): Q.Promise<string> {
        var deferred = Q.defer<string>();
        let webRequest = new webClient.WebRequest();
        webRequest.method = "POST";
        webRequest.uri = this.authorityUrl + (this.isADFSEnabled ? "" : this.domain) + "/oauth2/token/";
        webRequest.body = querystring.stringify({
            resource: this.activeDirectoryResourceId,
            client_id: this.clientId,
            grant_type: "client_credentials",
            client_secret: this.secret
        });
        webRequest.headers = {
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8"
        };

        let webRequestOptions: webClient.WebRequestOptions = {
            retriableErrorCodes: null,
            retriableStatusCodes: [400, 403, 408, 409, 500, 502, 503, 504],
            retryCount: null,
            retryIntervalInSeconds: null,
            retryRequestTimedout: null
        };

        webClient.sendRequest(webRequest, webRequestOptions).then(
            (response: webClient.WebResponse) => {
                if (response.statusCode == 200) {
                    deferred.resolve(response.body.access_token);
                }
                else if ([400, 401, 403].indexOf(response.statusCode) != -1) {
                    deferred.reject(tl.loc('ExpiredServicePrincipal'));
                }
                else {
                    deferred.reject(tl.loc('CouldNotFetchAccessTokenforAzureStatusCode', response.statusCode, response.statusMessage));
                }
            },
            (error) => {
                deferred.reject(error)
            }
        );

        return deferred.promise;
    }

    /**
     * @deprecated ADAL related methods are deprecated and will be removed. 
     * Use Use `getMSALToken(force?: boolean)` instead.
     */
    private _getSPNCertificateAuthorizationToken(): string {
        var openSSLPath = tl.osType().match(/^Win/) ? tl.which(path.join(__dirname, 'openssl', 'openssl')) : tl.which('openssl');
        var openSSLArgsArray = [
            "x509",
            "-noout",
            "-in",
            this.certFilePath,
            "-fingerprint"
        ];

        var pemExecutionResult = tl.execSync(openSSLPath, openSSLArgsArray);
        var additionalHeaders = {
            "alg": "RS256",
            "typ": "JWT",
        };

        if (pemExecutionResult.code == 0) {
            tl.debug("FINGERPRINT CREATION SUCCESSFUL");
            let shaFingerprint = pemExecutionResult.stdout;
            let shaFingerPrintHashCode = shaFingerprint.split("=")[1].replace(new RegExp(":", 'g'), "");
            let fingerPrintHashBase64: string = Buffer.from(
                shaFingerPrintHashCode.match(/\w{2}/g).map(function (a) {
                    return String.fromCharCode(parseInt(a, 16));
                }).join(""),
                'binary'
            ).toString('base64');
            additionalHeaders["x5t"] = fingerPrintHashBase64;
        }
        else {
            console.log(pemExecutionResult);
            throw new Error(pemExecutionResult.stderr);
        }

        return getJWT(this.authorityUrl, this.clientId, this.domain, this.certFilePath, additionalHeaders, this.isADFSEnabled);
    }
}

function getJWT(url: string, clientId: string, tenantId: string, pemFilePath: string, additionalHeaders, isADFSEnabled: boolean) {

    var pemFileContent = fs.readFileSync(pemFilePath);
    var jwtObject = {
        "aud": (`${url}/${!isADFSEnabled ? tenantId : ""}/oauth2/token`).replace(/([^:]\/)\/+/g, "$1"),
        "iss": clientId,
        "sub": clientId,
        "jti": "" + Math.random(),
        "nbf": (Math.floor(Date.now() / 1000) - 1000),
        "exp": (Math.floor(Date.now() / 1000) + 8640000)
    };

    var token = jwt.sign(jwtObject, pemFileContent, { algorithm: 'RS256', header: additionalHeaders });
    return token;
}
