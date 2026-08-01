import dns from 'dns/promises';

// A basic set of restricted CIDRs
const RESTRICTED_IPS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/
];

function isRestrictedIP(ip: string): boolean {
  return RESTRICTED_IPS.some(regex => regex.test(ip));
}

export async function validateUrl(inputUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch (err) {
    throw new Error('Invalid URL format');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Protocol not allowed');
  }

  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new Error('Port not allowed');
  }

  const hostname = url.hostname;
  
  if (hostname.match(/^(\d{1,3}\.){3}\d{1,3}$/) || hostname.includes(':')) {
    if (isRestrictedIP(hostname)) {
      throw new Error('Restricted IP address');
    }
  }

  try {
    const addresses = await dns.lookup(hostname, { all: true });
    for (const addr of addresses) {
      if (isRestrictedIP(addr.address)) {
        throw new Error('Resolved to restricted IP address');
      }
    }
  } catch (err: any) {
    if (err.message === 'Resolved to restricted IP address') {
      throw err;
    }
    throw new Error('DNS resolution failed');
  }

  return url;
}

export async function safeFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const validatedUrl = await validateUrl(url);
  
  const addresses = await dns.lookup(validatedUrl.hostname);
  const ip = addresses.address;
  if (isRestrictedIP(ip)) {
      throw new Error('Restricted IP address');
  }
  
  const finalUrl = new URL(validatedUrl.toString());
  finalUrl.hostname = ip;
  
  const headers = new Headers(options.headers);
  if (!headers.has('Host') && !headers.has('host')) {
    headers.set('Host', validatedUrl.hostname);
  }
  
  const fetchOptions: RequestInit = {
    ...options,
    headers,
    redirect: 'manual', 
    signal: options.signal || AbortSignal.timeout(5000), 
  };
  
  let response = await fetch(finalUrl.toString(), fetchOptions);
  
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) return response;
    
    const redirectUrl = new URL(location, validatedUrl).toString();
    await validateUrl(redirectUrl); 
    
    throw new Error('Redirects are not followed automatically for safety');
  }

  return response;
}
