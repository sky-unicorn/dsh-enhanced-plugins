export function ImageGallery({ images }: { images: readonly unknown[] }) {
  return images.length === 0 ? null : <div data-image-count={images.length} />
}
