/**
 * The overflow menu on a post.
 *
 * Reply, repost and like are the everyday actions and sit on the card.
 * Everything here is rare, consequential, or both - deleting is irreversible
 * and used to be a bin icon one stray tap from reply.
 *
 * "Ask the relays to delete" rather than "delete", because that is what NIP-09
 * is. The relays are not obliged to comply, a client that ignores kind 5 goes
 * on showing it, and anyone who already has a copy keeps it. Saying "deleted"
 * would be the app claiming a power it does not have.
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { kvGet } from '../../src/common/kv';
import { getRelays } from '../../src/features/relays/relays';
import type { PubkeyHex } from '../../types/nostr';
import type { TimelinePost } from '../lib/home-timeline';
import { requestDeletion } from '../lib/interact';
import ReportSheet from './ReportSheet';
import ZapSheet from './ZapSheet';

export interface PostMenuProps {
  post: TimelinePost;
  visible: boolean;
  onClose: () => void;
}

export default function PostMenu({ post, visible, onClose }: PostMenuProps) {
  const [reporting, setReporting] = useState(false);
  const [zapping, setZapping] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [gone, setGone] = useState(false);

  const viewer: string | null = kvGet('nostr_pubkey');
  const mine: boolean =
    Boolean(viewer) && viewer?.toLowerCase() === post.pubkey.toLowerCase();

  const confirmDelete = (): void => {
    Alert.alert(
      'Ask the relays to delete this post?',
      'They are not obliged to, and anyone who already has a copy keeps it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: (): void => {
            setDeleting(true);
            void requestDeletion(post.event, getRelays())
              .then((): void => {
                setGone(true);
                onClose();
              })
              .catch((error: unknown): void => {
                Alert.alert(
                  'Could not delete',
                  String((error as Error)?.message ?? error),
                );
              })
              .finally((): void => setDeleting(false));
          },
        },
      ],
    );
  };

  return (
    <>
      <Modal
        visible={visible && !reporting && !zapping}
        transparent
        animationType="fade"
        onRequestClose={onClose}
      >
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.sheet}>
          {mine ? (
            <Pressable
              onPress={confirmDelete}
              disabled={deleting || gone}
              style={styles.row}
            >
              {deleting ? (
                <ActivityIndicator color="#ff9a9a" />
              ) : (
                <Text style={styles.danger}>
                  {gone ? 'Deletion requested' : 'Delete this post'}
                </Text>
              )}
            </Pressable>
          ) : null}

          {viewer && !mine ? (
            <Pressable
              onPress={(): void => setZapping(true)}
              style={styles.row}
            >
              <Text style={styles.item}>⚡ Zap this post</Text>
            </Pressable>
          ) : null}

          <Pressable
            onPress={(): void => setReporting(true)}
            style={styles.row}
          >
            <Text style={styles.item}>Report this post</Text>
          </Pressable>

          <Pressable onPress={onClose} style={styles.row}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
        </View>
      </Modal>

      {viewer ? (
        <ZapSheet
          visible={zapping}
          recipientPubkey={post.pubkey}
          event={post.event}
          senderPubkey={viewer.toLowerCase() as PubkeyHex}
          onClose={(): void => {
            setZapping(false);
            onClose();
          }}
        />
      ) : null}

      <ReportSheet
        visible={reporting}
        target={post.pubkey}
        eventId={post.id}
        onClose={(): void => {
          setReporting(false);
          onClose();
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    backgroundColor: '#101a2e',
    borderTopWidth: 1,
    borderTopColor: '#25406e',
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 28,
  },
  row: { paddingHorizontal: 16, paddingVertical: 16, borderRadius: 10 },
  item: { color: '#e8eeff', fontSize: 16 },
  danger: { color: '#ff9a9a', fontSize: 16, fontWeight: '700' },
  cancel: { color: '#8ea0c0', fontSize: 16, textAlign: 'center' },
});
