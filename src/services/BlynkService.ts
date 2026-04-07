export interface BlynkServiceConfig {
  serverAddress: string;
  token: string;
}

const REQUEST_TIMEOUT_MS = 8000;

export class BlynkService {
  protected readonly serverAddress: string;
  protected readonly token: string;

  constructor({ serverAddress, token }: BlynkServiceConfig) {
    this.serverAddress = serverAddress;
    this.token = token;
  }

  protected async getPinValue(pin: string): Promise<string> {
    const url = new URL('/external/api/get', this.serverAddress);
    url.searchParams.append('token', this.token);
    url.searchParams.append(pin, '');

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Failed to get pin value for ${pin}: ${response.status}`);
    }

    return await response.text();
  }

  protected async setPinValue(pin: string, value: string): Promise<boolean> {
    const url = new URL('/external/api/update', this.serverAddress);
    url.searchParams.append('token', this.token);
    url.searchParams.append(pin, value);

    const response = await fetch(url.toString(), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Failed to set pin value for ${pin}: ${response.status}`);
    }

    const text = await response.text();
    return text === '1';
  }
}
