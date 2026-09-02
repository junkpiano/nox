/**
 * Sending a zap.
 *
 * The protocol is `common/zap-request.ts`, shared with the web: the LNURL
 * lookup, the kind:9734, the invoice and the checks on it. What is here is the
 * view and the paying, which is the one part that genuinely differs - a
 * browser has WebLN, and a phone has the wallet connected over NIP-47.
 *
 * Without a wallet the invoice is shown to copy or open. That is a payment
 * request rather than a wallet, which is also why zapping stays available on
 * iOS where a connected wallet does not.
 *
 * Nothing is paid automatically unless the invoice proved it commits to the
 * zap request that was signed. A Lightning payment cannot be undone, so "we
 * could not check this" has to mean "you decide", not "probably fine".
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { queryRelays } from '../../src/common/relay-query';
import type { ZapInvoice } from '../../src/common/zap-request';
import { requestZapInvoice } from '../../src/common/zap-request';
import { getRelays } from '../../src/features/relays/relays';
import { payInvoice } from '../../src/features/wallet/nwc-client';
import {
  getWalletConnection,
  loadWalletConnection,
} from '../../src/features/wallet/wallet-store';
import type { NostrEvent, NostrProfile, PubkeyHex } from '../../types/nostr';
import { signEventWithSession } from '../lib/publish';

const PRESETS: number[] = [21, 100, 500, 1000, 5000];

/** The recipient's kind:0, for the `lud16`/`lud06` in it. */
async function fetchZapProfile(
  pubkey: PubkeyHex,
): Promise<NostrProfile | null> {
  const events: NostrEvent[] = await queryRelays(getRelays(), {
    kinds: [0],
    authors: [pubkey],
    limit: 4,
  });
  const newest: NostrEvent | undefined = events
    .slice()
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!newest) {
    return null;
  }
  try {
    return JSON.parse(newest.content) as NostrProfile;
  } catch {
    return null;
  }
}

export interface ZapSheetProps {
  visible: boolean;
  recipientPubkey: PubkeyHex;
  /** Present when zapping a post rather than a person. */
  event?: NostrEvent;
  senderPubkey: PubkeyHex;
  onClose: () => void;
}

export default function ZapSheet({
  visible,
  recipientPubkey,
  event,
  senderPubkey,
  onClose,
}: ZapSheetProps) {
  const [amount, setAmount] = useState<number>(21);
  const [custom, setCustom] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ZapInvoice | null>(null);
  const [note, setNote] = useState('');

  const chosen: number = custom.trim() ? Number(custom.trim()) : amount;

  const close = (): void => {
    if (busy) return;
    setResult(null);
    setNote('');
    setComment('');
    setCustom('');
    onClose();
  };

  const send = (): void => {
    if (!Number.isFinite(chosen) || chosen <= 0) {
      setNote('Enter an amount in sats.');
      return;
    }

    setBusy(true);
    setNote('');
    void (async (): Promise<void> => {
      try {
        // The Lightning address lives in the recipient's kind:0, which the
        // timeline does not carry - it keeps a name and a face, and this is
        // the only screen that needs the rest.
        const recipientProfile: NostrProfile | null =
          await fetchZapProfile(recipientPubkey);

        const zap: ZapInvoice = await requestZapInvoice({
          senderPubkey,
          recipientPubkey,
          recipientProfile,
          ...(event ? { event } : {}),
          amountSats: chosen,
          comment,
          relays: getRelays(),
          sign: async (draft) => signEventWithSession(draft),
        });
        setResult(zap);

        // Collected rather than overwritten: the check on the invoice matters
        // more than the state of the wallet, and setting the note twice used
        // to hide the first one behind the second.
        const notes: string[] = [];
        if (zap.validation.warning) {
          notes.push(zap.validation.warning);
        }

        await loadWalletConnection();
        const wallet = getWalletConnection();
        if (wallet && zap.validation.canAutoPay) {
          await payInvoice(wallet, zap.invoice);
          notes.push('Paid.');
        } else if (!wallet) {
          notes.push(
            'No wallet is connected, so the invoice is here to pay however ' +
              'you like.',
          );
        } else {
          notes.push('Nothing was paid automatically.');
        }
        setNote(notes.join('\n\n'));
      } catch (error: unknown) {
        setNote(String((error as Error)?.message ?? error));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={close}
    >
      <Pressable style={styles.backdrop} onPress={close} />
      <View style={styles.sheet}>
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.title}>
            Zap {event ? 'this post' : 'this person'}
          </Text>

          <View style={styles.presets}>
            {PRESETS.map((preset: number) => {
              const on = !custom.trim() && preset === amount;
              return (
                <Pressable
                  key={preset}
                  onPress={(): void => {
                    setCustom('');
                    setAmount(preset);
                  }}
                  style={[styles.preset, on && styles.presetOn]}
                >
                  <Text style={on ? styles.presetTextOn : styles.presetText}>
                    {preset}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <TextInput
            value={custom}
            onChangeText={setCustom}
            placeholder="Any amount, in sats"
            placeholderTextColor="#5b6b88"
            keyboardType="number-pad"
            style={styles.input}
          />
          <TextInput
            value={comment}
            onChangeText={setComment}
            placeholder="Comment (optional)"
            placeholderTextColor="#5b6b88"
            style={styles.input}
          />

          {note ? <Text style={styles.note}>{note}</Text> : null}

          {result ? (
            <View style={styles.invoiceBox}>
              <Text style={styles.invoiceLabel}>Invoice</Text>
              <Text style={styles.invoice} numberOfLines={4} selectable>
                {result.invoice}
              </Text>
              <Pressable
                onPress={(): void => {
                  void Linking.openURL(`lightning:${result.invoice}`).catch(
                    (): void => {
                      Alert.alert(
                        'No Lightning app',
                        'Nothing on this phone offered to open a Lightning ' +
                          'invoice. The text above can be copied.',
                      );
                    },
                  );
                }}
                style={styles.secondary}
              >
                <Text style={styles.secondaryText}>Open in a wallet app</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>

        <View style={styles.footer}>
          <Pressable onPress={close} style={[styles.button, styles.cancel]}>
            <Text style={styles.cancelText}>{result ? 'Done' : 'Cancel'}</Text>
          </Pressable>
          {result ? null : (
            <Pressable
              onPress={send}
              disabled={busy}
              style={[styles.button, styles.confirm, busy && styles.off]}
            >
              {busy ? (
                <ActivityIndicator color="#0b1220" />
              ) : (
                <Text style={styles.confirmText}>Zap {chosen || 0}</Text>
              )}
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    backgroundColor: '#101a2e',
    borderTopWidth: 1,
    borderTopColor: '#25406e',
    maxHeight: '80%',
  },
  body: { padding: 20, gap: 12 },
  title: { color: '#f5f8ff', fontSize: 17, fontWeight: '700' },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  preset: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  presetOn: { borderColor: '#ffd79a', backgroundColor: '#221a0d' },
  presetText: { color: '#b9c6de', fontSize: 14 },
  presetTextOn: { color: '#ffd79a', fontSize: 14, fontWeight: '700' },
  input: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: '#e8eeff',
    fontSize: 14,
    backgroundColor: '#0b1220',
  },
  note: { color: '#ffd79a', fontSize: 12, lineHeight: 17 },
  invoiceBox: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    padding: 12,
    gap: 8,
    backgroundColor: '#0b1220',
  },
  invoiceLabel: { color: '#5b6b88', fontSize: 11 },
  invoice: { color: '#8ea0c0', fontSize: 11, lineHeight: 16 },
  secondary: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryText: { color: '#89a8ff', fontSize: 13, fontWeight: '700' },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: '#25406e',
  },
  button: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancel: { borderWidth: 1, borderColor: '#25406e' },
  cancelText: { color: '#b9c6de', fontWeight: '700', fontSize: 15 },
  confirm: { backgroundColor: '#ffd79a' },
  confirmText: { color: '#0b1220', fontWeight: '700', fontSize: 15 },
  off: { opacity: 0.5 },
});
