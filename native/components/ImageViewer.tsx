/**
 * Full-screen pictures, with pinch to zoom.
 *
 * Written against `PanResponder` and the core `Animated`, with no new
 * dependency. The obvious choice would be a gesture library, and the obvious
 * gesture library pulls react-native-reanimated - which is exactly what took
 * this project's build down once already, when expo-router dragged in
 * reanimated 4.6 and its worklets runtime landed outside the range
 * expo-modules-core declares. Two hundred lines here are cheaper than that
 * again.
 *
 * The interactions are the ones people try without being told: pinch to zoom,
 * drag to move while zoomed, double-tap to toggle, tap to close, and arrows
 * when a post carried more than one picture.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Image,
  Modal,
  PanResponder,
  type PanResponderInstance,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
/** Two taps further apart than this are two taps, not a double tap. */
const DOUBLE_TAP_MS = 280;

function distance(touches: Array<{ pageX: number; pageY: number }>): number {
  const [a, b] = touches;
  if (!a || !b) {
    return 0;
  }
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

export interface ImageViewerProps {
  urls: string[];
  /** Which one was tapped. Null closes the viewer. */
  index: number | null;
  onClose: () => void;
}

export default function ImageViewer({
  urls,
  index,
  onClose,
}: ImageViewerProps) {
  const [current, setCurrent] = useState<number>(index ?? 0);

  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  // Read back synchronously inside the responder, which cannot await a
  // listener. `Animated.Value` has no public getter, so the last committed
  // values are kept alongside.
  const committed = useRef({ scale: 1, x: 0, y: 0 });
  const gestureStart = useRef({ distance: 0, scale: 1, x: 0, y: 0 });
  const lastTap = useRef(0);

  useEffect((): void => {
    if (index !== null) {
      setCurrent(index);
    }
  }, [index]);

  const reset = (): void => {
    committed.current = { scale: 1, x: 0, y: 0 };
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
    ]).start();
  };

  const zoomTo = (next: number): void => {
    committed.current = { scale: next, x: 0, y: 0 };
    Animated.parallel([
      Animated.spring(scale, { toValue: next, useNativeDriver: true }),
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
    ]).start();
  };

  const show = (next: number): void => {
    reset();
    setCurrent(next);
  };

  const responder: PanResponderInstance = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (): boolean => true,
      onMoveShouldSetPanResponder: (_event, gesture): boolean =>
        // A zoomed picture claims the drag; an unzoomed one lets a tap
        // through so closing still works.
        committed.current.scale > 1 ||
        Math.abs(gesture.dx) > 4 ||
        Math.abs(gesture.dy) > 4,

      onPanResponderGrant: (event): void => {
        const touches = event.nativeEvent.touches;
        gestureStart.current = {
          distance: touches.length >= 2 ? distance(touches) : 0,
          scale: committed.current.scale,
          x: committed.current.x,
          y: committed.current.y,
        };
      },

      onPanResponderMove: (event, gesture): void => {
        const touches = event.nativeEvent.touches;

        if (touches.length >= 2) {
          const started: number = gestureStart.current.distance;
          const now: number = distance(touches);
          if (started > 0 && now > 0) {
            const next: number = Math.min(
              MAX_SCALE,
              Math.max(1, (gestureStart.current.scale * now) / started),
            );
            committed.current.scale = next;
            scale.setValue(next);
          }
          return;
        }

        if (committed.current.scale > 1) {
          const x: number = gestureStart.current.x + gesture.dx;
          const y: number = gestureStart.current.y + gesture.dy;
          committed.current.x = x;
          committed.current.y = y;
          translateX.setValue(x);
          translateY.setValue(y);
        }
      },

      onPanResponderRelease: (_event, gesture): void => {
        const moved: boolean =
          Math.abs(gesture.dx) > 6 || Math.abs(gesture.dy) > 6;

        if (!moved) {
          const now: number = Date.now();
          if (now - lastTap.current < DOUBLE_TAP_MS) {
            lastTap.current = 0;
            if (committed.current.scale > 1) {
              reset();
            } else {
              zoomTo(DOUBLE_TAP_SCALE);
            }
            return;
          }
          lastTap.current = now;
          // A single tap closes, but only from the unzoomed state: tapping
          // while zoomed in is how you miss the picture you were looking at.
          if (committed.current.scale <= 1) {
            setTimeout((): void => {
              if (lastTap.current !== 0) {
                onClose();
              }
            }, DOUBLE_TAP_MS);
          }
          return;
        }

        if (committed.current.scale <= 1) {
          reset();
        }
      },
    }),
  ).current;

  if (index === null) {
    return null;
  }

  const url: string | undefined = urls[current];
  const { width, height } = Dimensions.get('window');

  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.screen} {...responder.panHandlers}>
        {url ? (
          <Animated.Image
            source={{ uri: url }}
            resizeMode="contain"
            style={[
              { width, height },
              {
                transform: [{ translateX }, { translateY }, { scale }],
              },
            ]}
          />
        ) : null}
      </View>

      <View style={styles.chrome} pointerEvents="box-none">
        <Pressable onPress={onClose} hitSlop={16} style={styles.close}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>

        {urls.length > 1 ? (
          <View style={styles.pager} pointerEvents="box-none">
            <Pressable
              onPress={(): void =>
                show((current - 1 + urls.length) % urls.length)
              }
              hitSlop={16}
              style={styles.arrow}
            >
              <Text style={styles.arrowText}>‹</Text>
            </Pressable>
            <Text style={styles.count}>
              {current + 1} / {urls.length}
            </Text>
            <Pressable
              onPress={(): void => show((current + 1) % urls.length)}
              hitSlop={16}
              style={styles.arrow}
            >
              <Text style={styles.arrowText}>›</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chrome: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'space-between',
  },
  close: { alignSelf: 'flex-end', padding: 20, marginTop: 28 },
  closeText: { color: '#fff', fontSize: 26, fontWeight: '300' },
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    paddingBottom: 40,
  },
  arrow: { paddingHorizontal: 16, paddingVertical: 8 },
  arrowText: { color: '#fff', fontSize: 34, fontWeight: '300' },
  count: { color: '#fff', fontSize: 14 },
});
