import { Button } from '@/components/Button'
import Image, { type ImageProps } from 'next/image'
import { Container } from '@/components/Container'
import image404 from '@/images/photos/image-404.jpg'
export default function NotFound() {
  return (
    <Container className="flex h-full items-center pt-16 sm:pt-32">
      <div className="flex flex-col items-center">
        <p className="mb-4 text-4xl font-semibold text-zinc-600 dark:text-zinc-300">
          404
        </p>
        <Image
          src={image404}
          alt=""
          sizes="(min-width: 1024px) 32rem, 20rem"
          className="aspect-square rotate-3 rounded-2xl"
        />
        <h1 className="mt-4 text-4xl font-bold tracking-tight text-zinc-800 dark:text-zinc-100 sm:text-5xl">
          Oops...
        </h1>
        <p className="mt-4 text-base text-zinc-600 dark:text-zinc-400">
          Sorry, I couldn’t find the page you’re looking for.
        </p>
        <Button href="/" variant="secondary" className="mt-4">
          Come back to the homepage?
        </Button>
      </div>
    </Container>
  )
}
