/**
 * NIP-56 reporting.
 *
 * A report is public. It is addressed to relay operators, who may act on it,
 * slowly, or not at all - and unlike the mute list it cannot be taken back,
 * because it is an event on somebody else's relay. The wording says so rather
 * than implying this screen removes anything.
 *
 * Muting is offered in the same breath and defaults to on. Reporting is a
 * request in somebody else's queue; muting is the part that changes what this
 * person sees now, and a report that visibly does nothing is not protection.
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { isMuted } from '../../src/common/mute-state';
import {
  muteUser,
  reportContent,
} from '../../src/features/moderation/moderation-actions';
import type { ReportType } from '../../src/features/moderation/report';
import { REPORT_TYPE_LABELS } from '../../src/features/moderation/report';
import { getRelays } from '../../src/features/relays/relays';
import type { PubkeyHex } from '../../types/nostr';

export interface ReportSheetProps {
  visible: boolean;
  target: PubkeyHex;
  /** Present when reporting one post; absent when reporting the account. */
  eventId?: string;
  onClose: () => void;
}

export default function ReportSheet({
  visible,
  target,
  eventId,
  onClose,
}: ReportSheetProps) {
  const [reason, setReason] = useState<ReportType>('spam');
  const [comment, setComment] = useState('');
  const [alsoMute, setAlsoMute] = useState(true);
  const [busy, setBusy] = useState(false);

  const alreadyMuted: boolean = isMuted(target);

  const close = (): void => {
    if (busy) return;
    setComment('');
    setReason('spam');
    setAlsoMute(true);
    onClose();
  };

  const submit = (): void => {
    void (async (): Promise<void> => {
      setBusy(true);
      try {
        await reportContent({
          targetPubkey: target,
          ...(eventId ? { eventId } : {}),
          reportType: reason,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          relays: getRelays(),
        });
      } catch (e: any) {
        setBusy(false);
        Alert.alert('Could not send the report', String(e?.message ?? e));
        return;
      }

      // The report is away. Muting is a separate publish and can fail on its
      // own, so its failure is reported as its own thing rather than making
      // the whole action look unsuccessful.
      let muted = false;
      if (alsoMute && !alreadyMuted) {
        try {
          await muteUser(target, getRelays());
          muted = true;
        } catch {
          muted = isMuted(target);
        }
      }

      setBusy(false);
      setComment('');
      onClose();
      Alert.alert(
        'Report sent',
        muted
          ? 'It has gone to your relays, for their operators to look at. You ' +
              'will not see this account here any more.'
          : 'It has gone to your relays, for their operators to look at. ' +
              'What happens next is up to them.',
      );
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
        <Text style={styles.title}>
          Report {eventId ? 'this post' : 'this account'}
        </Text>
        <Text style={styles.note}>
          Reports are public and cannot be withdrawn. They go to the operators
          of your relays, who decide what to do with them.
        </Text>

        <ScrollView style={styles.reasons}>
          {REPORT_TYPE_LABELS.map((entry) => {
            const picked = entry.value === reason;
            return (
              <Pressable
                key={entry.value}
                onPress={(): void => setReason(entry.value)}
                style={[styles.reason, picked && styles.reasonPicked]}
              >
                <Text style={picked ? styles.reasonTextOn : styles.reasonText}>
                  {entry.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <TextInput
          value={comment}
          onChangeText={setComment}
          placeholder="Anything else they should know (optional)"
          placeholderTextColor="#5b6b88"
          multiline
          maxLength={500}
          style={styles.comment}
        />

        {alreadyMuted ? null : (
          <View style={styles.muteRow}>
            <Text style={styles.muteLabel}>Also mute this account</Text>
            <Switch
              value={alsoMute}
              onValueChange={setAlsoMute}
              trackColor={{ false: '#25406e', true: '#3c5fa8' }}
              thumbColor={alsoMute ? '#89a8ff' : '#5b6b88'}
            />
          </View>
        )}

        <View style={styles.buttons}>
          <Pressable
            onPress={close}
            disabled={busy}
            style={[styles.button, styles.cancel]}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={submit}
            disabled={busy}
            style={[styles.button, styles.confirm, busy && styles.buttonOff]}
          >
            {busy ? (
              <ActivityIndicator color="#0b1220" />
            ) : (
              <Text style={styles.confirmText}>Report</Text>
            )}
          </Pressable>
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
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 28,
    gap: 12,
  },
  title: { color: '#f5f8ff', fontSize: 17, fontWeight: '700' },
  note: { color: '#8ea0c0', fontSize: 12, lineHeight: 17 },
  reasons: { maxHeight: 220 },
  reason: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 11,
    marginBottom: 8,
  },
  reasonPicked: { borderColor: '#89a8ff', backgroundColor: '#16233f' },
  reasonText: { color: '#b9c6de', fontSize: 14 },
  reasonTextOn: { color: '#e8eeff', fontSize: 14, fontWeight: '700' },
  comment: {
    borderWidth: 1,
    borderColor: '#25406e',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: '#e8eeff',
    fontSize: 14,
    backgroundColor: '#0b1220',
    minHeight: 64,
    textAlignVertical: 'top',
  },
  muteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  muteLabel: { color: '#b9c6de', fontSize: 14 },
  buttons: { flexDirection: 'row', gap: 10 },
  button: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancel: { borderWidth: 1, borderColor: '#25406e' },
  cancelText: { color: '#b9c6de', fontWeight: '700', fontSize: 15 },
  confirm: { backgroundColor: '#89a8ff' },
  confirmText: { color: '#0b1220', fontWeight: '700', fontSize: 15 },
  buttonOff: { opacity: 0.5 },
});
