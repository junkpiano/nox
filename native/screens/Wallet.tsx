/**
 * A Lightning wallet over NIP-47.
 *
 * This screen does not exist on iOS. The App Store treats a connected wallet
 * as a wallet and asks that wallets come from developers registered as
 * organisations; Google's policy exempts non-custodial ones, so Android keeps
 * it. Both the entry point and the route are withheld there - hiding a nav
 * item is not the same as closing a door somebody can still reach through
 * history.
 *
 * Zapping is unaffected either way: without a connection the invoice is shown
 * as a QR code, which is a payment request rather than a wallet.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { onAppEvent } from '../../src/common/app-events';
import type { NwcConnection } from '../../src/features/wallet/nwc-client';
import {
  getBalance,
  NwcError,
  parseNwcUri,
  payInvoice,
} from '../../src/features/wallet/nwc-client';
import {
  clearWalletConnection,
  getWalletAlias,
  getWalletConnection,
  loadWalletConnection,
  saveWalletConnection,
} from '../../src/features/wallet/wallet-store';

function describe(error: unknown): string {
  if (error instanceof NwcError) {
    return error.message;
  }
  return String((error as Error)?.message ?? error);
}

export default function Wallet() {
  const [connection, setConnection] = useState<NwcConnection | null>(null);
  const [alias, setAlias] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const [uri, setUri] = useState('');
  const [connecting, setConnecting] = useState(false);

  const [balance, setBalance] = useState<number | null>(null);
  const [balanceError, setBalanceError] = useState('');
  const [loadingBalance, setLoadingBalance] = useState(false);

  const [invoice, setInvoice] = useState('');
  const [paying, setPaying] = useState(false);
  const [payNote, setPayNote] = useState('');

  const readConnection = useCallback((): void => {
    setConnection(getWalletConnection());
    void getWalletAlias().then(setAlias);
  }, []);

  useEffect((): void => {
    void loadWalletConnection().then((): void => {
      readConnection();
      setReady(true);
    });
  }, [readConnection]);

  useEffect(
    (): (() => void) => onAppEvent('wallet-connection-changed', readConnection),
    [readConnection],
  );

  const refreshBalance = useCallback((): void => {
    const current = getWalletConnection();
    if (!current) return;
    setLoadingBalance(true);
    setBalanceError('');
    void getBalance(current)
      .then(setBalance)
      .catch((error: unknown): void => setBalanceError(describe(error)))
      .finally((): void => setLoadingBalance(false));
  }, []);

  useEffect((): void => {
    if (connection) {
      refreshBalance();
    }
  }, [connection, refreshBalance]);

  const connect = (): void => {
    const value = uri.trim();
    if (!value) return;
    setConnecting(true);
    void (async (): Promise<void> => {
      try {
        // Parsed before it is stored. A malformed string saved now is a
        // failure at the next payment instead of at the moment it was pasted.
        const parsed: NwcConnection = parseNwcUri(value);
        await saveWalletConnection(parsed);
        setUri('');
        readConnection();
      } catch (error: unknown) {
        Alert.alert('That connection string did not work', describe(error));
      } finally {
        setConnecting(false);
      }
    })();
  };

  const disconnect = (): void => {
    Alert.alert(
      'Disconnect this wallet?',
      'The connection secret is deleted from this phone. Your wallet and its ' +
        'balance are untouched - this app simply stops being able to spend ' +
        'from it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: (): void => {
            void clearWalletConnection().then((): void => {
              setBalance(null);
              readConnection();
            });
          },
        },
      ],
    );
  };

  const pay = (): void => {
    const value = invoice.trim();
    const current = getWalletConnection();
    if (!value || !current) return;

    Alert.alert(
      'Pay this invoice?',
      'A Lightning payment cannot be reversed once the wallet has made it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Pay',
          onPress: (): void => {
            setPaying(true);
            setPayNote('');
            void payInvoice(current, value)
              .then((): void => {
                setInvoice('');
                setPayNote('Paid.');
                refreshBalance();
              })
              .catch((error: unknown): void => {
                setPayNote(`Not paid: ${describe(error)}`);
              })
              .finally((): void => setPaying(false));
          },
        },
      ],
    );
  };

  if (!ready) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color="#89a8ff" />
      </View>
    );
  }

  if (!connection) {
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
        <Text style={styles.heading}>Connect a wallet</Text>
        <Text style={styles.hint}>
          Paste your wallet connection string to send tips. It is kept in this
          phone's credential store and deleted when you sign out.
        </Text>
        <TextInput
          value={uri}
          onChangeText={setUri}
          placeholder="nostr+walletconnect://..."
          placeholderTextColor="#5b6b88"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={[styles.input, styles.uriInput]}
        />
        <Pressable
          onPress={connect}
          disabled={connecting || uri.trim().length === 0}
          style={[
            styles.primary,
            (connecting || uri.trim().length === 0) && styles.off,
          ]}
        >
          {connecting ? (
            <ActivityIndicator color="#0b1220" />
          ) : (
            <Text style={styles.primaryText}>Connect</Text>
          )}
        </Pressable>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <Text style={styles.heading}>{alias || 'Connected wallet'}</Text>

      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>Balance</Text>
        {loadingBalance ? (
          <ActivityIndicator color="#89a8ff" />
        ) : balanceError ? (
          <Text style={styles.error}>{balanceError}</Text>
        ) : (
          <Text style={styles.balance}>
            {balance === null ? '—' : `${balance.toLocaleString()} sats`}
          </Text>
        )}
        <Pressable onPress={refreshBalance} hitSlop={8}>
          <Text style={styles.link}>Refresh</Text>
        </Pressable>
      </View>

      <Text style={styles.heading}>Pay an invoice</Text>
      <TextInput
        value={invoice}
        onChangeText={setInvoice}
        placeholder="lnbc..."
        placeholderTextColor="#5b6b88"
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        style={[styles.input, styles.uriInput]}
      />
      {payNote ? <Text style={styles.note}>{payNote}</Text> : null}
      <Pressable
        onPress={pay}
        disabled={paying || invoice.trim().length === 0}
        style={[
          styles.primary,
          (paying || invoice.trim().length === 0) && styles.off,
        ]}
      >
        {paying ? (
          <ActivityIndicator color="#0b1220" />
        ) : (
          <Text style={styles.primaryText}>Pay</Text>
        )}
      </Pressable>

      <Pressable onPress={disconnect} style={styles.danger}>
        <Text style={styles.dangerText}>Disconnect this wallet</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1220' },
  body: { padding: 20, gap: 12 },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b1220',
  },
  heading: { color: '#f5f8ff', fontSize: 16, fontWeight: '700', marginTop: 6 },
  hint: { color: '#8ea0c0', fontSize: 12, lineHeight: 18 },
  input: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: '#e8eeff',
    fontSize: 13,
    backgroundColor: '#101a2e',
  },
  uriInput: { minHeight: 72, textAlignVertical: 'top' },
  primary: {
    backgroundColor: '#89a8ff',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  primaryText: { color: '#0b1220', fontWeight: '700', fontSize: 15 },
  off: { opacity: 0.4 },
  balanceCard: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 12,
    padding: 16,
    gap: 6,
    backgroundColor: '#101a2e',
  },
  balanceLabel: { color: '#5b6b88', fontSize: 12 },
  balance: { color: '#73f0c1', fontSize: 26, fontWeight: '700' },
  link: { color: '#89a8ff', fontSize: 12, marginTop: 2 },
  note: { color: '#8ea0c0', fontSize: 12, lineHeight: 17 },
  error: { color: '#ff9a9a', fontSize: 13 },
  danger: {
    marginTop: 18,
    borderWidth: 1,
    borderColor: '#5a2a2a',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  dangerText: { color: '#ff9a9a', fontWeight: '700', fontSize: 14 },
});
