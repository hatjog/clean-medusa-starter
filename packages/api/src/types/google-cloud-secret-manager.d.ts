declare module "@google-cloud/secret-manager" {
  export type AccessSecretVersionRequest = {
    name: string
  }

  export type AccessSecretVersionResponse = {
    payload?: {
      data?: string | Uint8Array | Buffer | null
    } | null
  }

  export class SecretManagerServiceClient {
    accessSecretVersion(
      request: AccessSecretVersionRequest
    ): Promise<[AccessSecretVersionResponse]>
  }
}
