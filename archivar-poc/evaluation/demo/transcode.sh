#!/usr/bin/env bash
set -Eeuo pipefail

# Transcode the demo assets into a broad format matrix, written as demo.*
# directly into sample_data/test (no subdirectory).
#
#   video containers:  from sample_data/test/demo.webm (video + audio)
#   audio-only:        from the audio track of demo.webm
#   image formats:     from sample_data/test/demo.png (extracted first frame)
#
# The matrix covers common/legacy/professional containers and codecs for
# player/compatibility probing. Formats that fail on this input or with this
# ffmpeg build are dropped with a note and do not fail the run.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${TARGET_DIR:-$(realpath -m "$SCRIPT_DIR/../../../sample_data/test")}"

INPUT="${1:-$TARGET_DIR/demo.webm}"
FRAME="${2:-$TARGET_DIR/demo.png}"
OUT_DIR="$TARGET_DIR"

[[ -f "$INPUT" ]] || { echo "transcode.sh: input not found: $INPUT" >&2; exit 1; }
[[ -f "$FRAME" ]] || { echo "transcode.sh: frame not found: $FRAME" >&2; exit 1; }

SUCCEEDED=()
FAILED=()

# transcode_video EXT [ffmpeg args...]
transcode_video() {
  local ext="$1"
  shift
  local output="$OUT_DIR/demo.${ext}"
  echo "==> $output"
  if ffmpeg -hide_banner -loglevel error -y -i "$INPUT" "$@" "$output"; then
    SUCCEEDED+=("demo.${ext}")
  else
    echo "NOTE: dropped demo.${ext} (unsupported by this input/ffmpeg build)" >&2
    rm -f -- "$output"
    FAILED+=("demo.${ext}")
  fi
}

# transcode_audio NAME [ffmpeg args...]
# NAME without a dot gets "demo." prefix (demo.flac), with a dot "demo-"
# (demo-alac.m4a) — the established demo file naming.
transcode_audio() {
  local name="$1"
  shift
  local file="demo.${name}"
  [[ "$name" == *.* ]] && file="demo-${name}"
  local output="$OUT_DIR/$file"
  echo "==> $output"
  if ffmpeg -hide_banner -loglevel error -y -i "$INPUT" -map 0:a:0 -vn "$@" "$output"; then
    SUCCEEDED+=("$file")
  else
    echo "NOTE: dropped $file (unsupported by this input/ffmpeg build)" >&2
    rm -f -- "$output"
    FAILED+=("$file")
  fi
}

# transcode_image NAME [ffmpeg args...]   (same naming rule as transcode_audio)
transcode_image() {
  local name="$1"
  shift
  local file="demo.${name}"
  [[ "$name" == *.* ]] && file="demo-${name}"
  local output="$OUT_DIR/$file"
  echo "==> $output"
  if ffmpeg -hide_banner -loglevel error -y \
      -i "$FRAME" \
      -frames:v 1 \
      "$@" \
      -f image2 \
      -update 1 \
      "$output"; then
    SUCCEEDED+=("$file")
  else
    echo "NOTE: dropped $file (unsupported by this input/ffmpeg build)" >&2
    rm -f -- "$output"
    FAILED+=("$file")
  fi
}

# ---------------------------------------------------------------------------
# Video containers (from demo.webm)
# demo.webm itself already exists (VP9/Opus) and is not regenerated.
# ---------------------------------------------------------------------------

# ISO Base Media / QuickTime
for ext in mp4 m4v; do
  transcode_video "$ext" \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 192k -movflags +faststart \
    -f mp4
done

for ext in mov qt; do
  transcode_video "$ext" \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 192k \
    -f mov
done

# Matroska
for ext in mkv mk3d; do
  transcode_video "$ext" \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 192k \
    -f matroska
done

# AVI family
transcode_video avi \
  -c:v mpeg4 -q:v 3 -vtag FMP4 \
  -c:a libmp3lame -b:a 192k \
  -f avi

transcode_video divx \
  -c:v mpeg4 -q:v 3 -vtag DIVX \
  -c:a libmp3lame -b:a 192k \
  -f avi

transcode_video xvid \
  -c:v libxvid -q:v 3 -vtag XVID \
  -c:a libmp3lame -b:a 192k \
  -f avi

# MPEG program streams
for ext in mpg mpeg mpe; do
  transcode_video "$ext" \
    -vf "fps=25" \
    -c:v mpeg2video -q:v 3 \
    -b:v 2500k -maxrate 2500k -bufsize 1835k \
    -c:a mp2 -b:a 192k \
    -f mpeg
done

# MPEG elementary video streams: no audio
transcode_video m1v \
  -an \
  -vf "fps=25" \
  -c:v mpeg1video \
  -q:v 3 \
  -f mpeg1video

transcode_video m2v \
  -an \
  -vf "fps=25" \
  -c:v mpeg2video \
  -q:v 3 \
  -f mpeg2video

# MPEG transport streams
for ext in ts m2ts mts; do
  transcode_video "$ext" \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 192k \
    -f mpegts
done

# MXF
transcode_video mxf \
  -vf "fps=25" \
  -fps_mode cfr \
  -c:v mpeg2video \
  -pix_fmt yuv422p \
  -b:v 50M -minrate 50M -maxrate 50M \
  -bufsize 17825792 \
  -bt 50M \
  -g 12 \
  -c:a pcm_s16le \
  -ar 48000 \
  -f mxf

# DVD/VOB
transcode_video vob \
  -target pal-dvd \
  -aspect 16:9 \
  -f vob

# Ogg video
transcode_video ogv \
  -c:v libtheora -q:v 7 \
  -c:a libvorbis -q:a 5 \
  -f ogg

transcode_video ogm \
  -c:v libtheora -q:v 7 \
  -c:a libvorbis -q:a 5 \
  -f ogg

# Flash
transcode_video flv \
  -c:v flv1 -q:v 4 \
  -c:a libmp3lame -b:a 128k \
  -f flv

transcode_video f4v \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 192k \
  -f mp4

# ASF / Windows Media
transcode_video asf \
  -c:v msmpeg4v3 -q:v 3 \
  -c:a wmav2 -b:a 192k \
  -f asf

transcode_video wmv \
  -c:v wmv2 -q:v 3 \
  -c:a wmav2 -b:a 192k \
  -f asf

# Mobile formats
transcode_video 3gp \
  -vf "scale='min(640,iw)':-2" \
  -c:v libx264 -profile:v baseline -level 3.0 \
  -preset medium -crf 23 -pix_fmt yuv420p \
  -c:a aac -b:a 96k -ac 2 -ar 44100 \
  -f 3gp

transcode_video 3g2 \
  -vf "scale='min(640,iw)':-2" \
  -c:v mpeg4 -q:v 4 \
  -c:a aac -b:a 96k -ac 2 -ar 44100 \
  -f 3g2

# RealMedia; availability depends on FFmpeg build
for ext in rm rmvb; do
  transcode_video "$ext" \
    -c:v rv20 -q:v 4 \
    -c:a ac3 -b:a 128k \
    -f rm
done

# NUT
transcode_video nut \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -c:a flac \
  -f nut

# Raw YUV4MPEG video: no audio
transcode_video y4m \
  -an -c:v rawvideo -pix_fmt yuv420p \
  -f yuv4mpegpipe

# PAL DV requires fixed dimensions, frame rate and audio layout; the
# asetpts/atrim/apad chain realigns the (Opus) audio to DV frame boundaries.
transcode_video dv \
  -vf "scale=720:576:force_original_aspect_ratio=decrease,\
pad=720:576:(ow-iw)/2:(oh-ih)/2,setsar=16/15" \
  -r 25 \
  -c:v dvvideo -pix_fmt yuv420p \
  -af "asetpts=N/SR/TB,atrim=0:10,apad" \
  -c:a pcm_s16le -ar 48000 -ac 2 \
  -t 10 \
  -f dv

# ---------------------------------------------------------------------------
# Audio-only formats (from the audio track of demo.webm)
# ---------------------------------------------------------------------------

# ALAC, lossless, in an M4A container
transcode_audio alac.m4a \
  -c:a alac

# FLAC, lossless
transcode_audio flac \
  -c:a flac -compression_level 8

# AAC in an M4A container
transcode_audio aac.m4a \
  -c:a aac -b:a 192k

# Dolby Digital / AC-3
transcode_audio ac3 \
  -c:a ac3 -b:a 384k -ar 48000

# MPEG Layer II
transcode_audio mp2 \
  -c:a mp2 -b:a 192k -ar 48000

# Windows Media Audio
transcode_audio wma \
  -c:a wmav2 -b:a 192k

# AIFF with lossless 24-bit big-endian PCM
transcode_audio aiff \
  -c:a pcm_s24be

# Sun/NeXT AU with lossless 16-bit big-endian PCM
transcode_audio au \
  -c:a pcm_s16be

# Core Audio Format with lossless 24-bit PCM
transcode_audio caf \
  -c:a pcm_s24le

# WAV with lossless 16-bit PCM
transcode_audio wav \
  -c:a pcm_s16le

# MP3
transcode_audio mp3 \
  -c:a libmp3lame -b:a 192k

# ---------------------------------------------------------------------------
# Image formats (from demo.png)
# demo.png itself already exists and is not regenerated.
# ---------------------------------------------------------------------------

# Common and modern web formats
transcode_image jpg \
  -c:v mjpeg \
  -q:v 2 \
  -pix_fmt yuvj444p

transcode_image lossy.webp \
  -c:v libwebp \
  -quality 90 \
  -compression_level 6

transcode_image lossless.webp \
  -c:v libwebp \
  -lossless 1 \
  -quality 100 \
  -compression_level 6 \
  -pix_fmt rgba

transcode_image avif \
  -c:v libaom-av1 \
  -still-picture 1 \
  -crf 20 \
  -cpu-used 4 \
  -pix_fmt yuv444p

transcode_image jxl \
  -c:v libjxl \
  -distance 0 \
  -effort 7

# JPEG family
transcode_image jp2 \
  -c:v jpeg2000 \
  -pred 1 \
  -pix_fmt rgb24

transcode_image j2k \
  -c:v jpeg2000 \
  -pred 1 \
  -pix_fmt rgb24

transcode_image jls \
  -c:v jpegls \
  -pix_fmt rgb24

transcode_image ljpg \
  -c:v ljpeg \
  -pix_fmt bgr24

# General raster formats
transcode_image tiff \
  -c:v tiff \
  -compression_algo deflate \
  -pix_fmt rgba

transcode_image gif \
  -filter_complex \
  "[0:v]split[a][b]; \
   [a]palettegen=max_colors=256[p]; \
   [b][p]paletteuse=dither=sierra2_4a"

transcode_image bmp \
  -c:v bmp \
  -pix_fmt bgr24

transcode_image tga \
  -c:v targa \
  -pix_fmt bgra

transcode_image pcx \
  -c:v pcx \
  -pix_fmt rgb24

transcode_image qoi \
  -c:v qoi \
  -pix_fmt rgba

# Professional, scientific and HDR-capable formats
transcode_image dpx \
  -c:v dpx \
  -pix_fmt gbrp10le

transcode_image exr \
  -c:v exr \
  -compression zip1 \
  -pix_fmt gbrpf32le

transcode_image hdr \
  -c:v hdr \
  -pix_fmt gbrpf32le

transcode_image fits \
  -c:v fits \
  -pix_fmt gbrp16le

# Netpbm / portable anymap family
transcode_image pam \
  -c:v pam \
  -pix_fmt rgba

transcode_image ppm \
  -c:v ppm \
  -pix_fmt rgb24

transcode_image pgm \
  -vf format=gray \
  -c:v pgm

transcode_image pbm \
  -vf format=monow \
  -c:v pbm

# Legacy workstation and bitmap formats
transcode_image sgi \
  -c:v sgi \
  -pix_fmt rgb24

transcode_image ras \
  -c:v sunrast \
  -pix_fmt bgr24

transcode_image xbm \
  -vf format=monow \
  -c:v xbm

transcode_image xwd \
  -c:v xwd \
  -pix_fmt bgra

transcode_image wbmp \
  -vf format=monow \
  -c:v wbmp

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo
echo "Completed: ${#SUCCEEDED[@]} format(s) -> $OUT_DIR"

if ((${#FAILED[@]} > 0)); then
  echo
  echo "Dropped (unsupported on this input/ffmpeg build): ${#FAILED[@]} format(s)" >&2
  printf '  %s\n' "${FAILED[@]}" >&2
fi
