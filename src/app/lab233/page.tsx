import { Card } from '@/components/Card'
import { Section } from '@/components/Section'
import { SimpleLayout } from '@/components/SimpleLayout'

function ToolsSection({
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof Section>) {
  return (
    <Section {...props}>
      <ul role="list" className="space-y-16">
        {children}
      </ul>
    </Section>
  )
}

function Tool({
  title,
  href,
  children,
}: {
  title: string
  href?: string
  children: React.ReactNode
}) {
  return (
    <Card as="li">
      <Card.Title as="h3" href={href}>
        {title}
      </Card.Title>
      <Card.Description>{children}</Card.Description>
    </Card>
  )
}

export const metadata = {
  title: 'Lab233',
  description: "Just the favorites in my home lab if you're ever wondering.",
}

export default function Uses() {
  return (
    <SimpleLayout
      title="Tools and gadgets I use."
      intro="Just the favorites in my home lab if you're ever wondering."
    >
      <div className="space-y-20">
        <ToolsSection title="Workstation">
          <Tool title="Sona - 16” MacBook Pro, 2020, 1TB Storage">
            This is my sidekick. I carry it everywhere I go. If I'm in a bind
            and need quick compute or if I need to watch a movie or doom scroll
            social media, I summon Sona. I've replaced the screen once after an
            unfortunate battle with gravity. Gravity won.
          </Tool>
          <Tool title="Warlock - Custom built L-CLASS from OriginPC">
            This is my main workstation. I built it to be a powerhouse for
            gaming, coding, and YouTube videos. It has a 13th Gen Intel Core i9.
            64GB of RAM, an NVIDIA GeForce RTX 3080 Ti. I’ve been using it since
            November 2022. It’s still a beast.
          </Tool>
          <Tool title="Keychron Q6 Mechanical Keyboard">
            I don't think I can go back to a "normal" keyboard for gaming. The
            Q6 is a great keyboard for gaming and typing. I love the feel of the
            keys and the sound of the banana switches. I use it wired because I
            don't trust wireless for gaming.
          </Tool>
          <Tool title="MX Master 3 Mouse">
            I have a love-hate relationship with this mouse. I hate that I have
            4 of them. It costs a pretty penny. I just love the design,
            functionality and ergonomics of this mouse. I always carry one in my
            backpack and when I don't have it, I feel slowed down. I have one
            dedicated for Warlock and at least one more in a drawer somewhere.
          </Tool>
        </ToolsSection>
        <ToolsSection title="Development tools">
          <Tool title="Visual Studio Code">
            I still use Vim when I have no access to a more desktop oriented
            IDE. However, you can bet I will be using VS Code whenever I have
            access to that. VS Code is versatile, well supported and I
            appreciate the varying color themes that help reduce eye strain for
            me.
          </Tool>

          <Tool title="Drawio">
            I feel the need to call out Drawio. I like visualizing things and
            writing down ideas, I communicated best that way. Whenever I can put
            forth a visual representation of a project I am working on, it helps
            me move faster. Now, that is why I use drawio, a lot.
          </Tool>
        </ToolsSection>
        <ToolsSection title="Design">
          <Tool title="Adobe Creative Cloud">
            Yup, I pay for the full suite. I use Photoshop, Illustrator, and
            everything. I hate it but also feels like I can't live without it.
            I've tried to use other tools but I always come back to Adobe. Yes,
            I have also cancelled and re-activated my subscription a few times.
          </Tool>
        </ToolsSection>
        <ToolsSection title="AI Tools">
          <Tool title="ChatGPT">
            I find myself using it for search, sometimes in place of Google. It
            defifnitely beats Stack Overflow when I need to find a solution to a
            problem or need to understand a piece of code very quickly. I like
            that I can query follow up questions.
          </Tool>
          <Tool title="Midjourney AI">
            Generating images for my side projects has never been easier.
            Midjourney just gets the job done. Yup, occasionally, it generates a
            Charlie Foxtrot that is just mind warping!! ***shudders***
          </Tool>
        </ToolsSection>
      </div>
    </SimpleLayout>
  )
}
