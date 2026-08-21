/**
 * The header: sign in, sign out, and who you are.
 *
 * Shared by every page so there is one place that knows what "signed in" means.
 * The session is a bearer token the server issued after verifying a signature
 * over a message the server itself rendered — the page never composes that
 * message and never proves anything on the user's behalf.
 */

import { api, sessionAddress, setSession, wallet, shortHash } from './api.mjs';

export function notify(container, message, kind = '') {
  const node = document.getElementById(container);
  if (node === null) return;
  node.innerHTML = message === null ? '' : `<div class="notice ${kind}">${message}</div>`;
}

export function mountShell() {
  const who = document.getElementById('who');
  const button = document.getElementById('signin');
  if (who === null || button === null) return;

  const render = () => {
    const address = sessionAddress();
    if (address === null) {
      who.textContent = '';
      button.textContent = 'Sign in';
      return;
    }
    who.textContent = shortHash(address, 8, 6);
    button.textContent = 'Sign out';
  };

  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (sessionAddress() !== null) {
        // Revoked server-side as well as forgotten locally. Clearing only the
        // browser copy would leave a live token behind.
        await api.logout().catch(() => undefined);
        setSession(null);
      } else {
        if (!wallet.available()) throw new Error('No wallet found in this browser.');
        await wallet.signIn();
      }
      render();
      window.dispatchEvent(new CustomEvent('covenant:session'));
    } catch (error) {
      notify('status', `Sign-in failed: ${error.message}`, 'error');
    } finally {
      button.disabled = false;
    }
  });

  render();
}
