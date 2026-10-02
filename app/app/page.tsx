import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Github, Linkedin, Twitter, Mail, ExternalLink, MapPin } from "lucide-react"
import { ThemeToggle } from "@/components/theme-toggle"
import ParticleWave from "@/components/particle-wave"

export default function Portfolio() {
  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-end mb-6">
          <ThemeToggle />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6 auto-rows-max">
          {/* About Me - Tall Card (Top Left) */}
          <Card
            id="about"
            className="md:col-span-3 lg:col-span-4 p-8 bg-gradient-to-br from-card to-card/50 border border-border/50 relative overflow-hidden rounded-3xl shadow-sm"
          >
            <div className="absolute inset-0 z-0 opacity-30">
              <ParticleWave />
            </div>
            <div className="flex flex-col h-full relative z-10">
              <div className="flex items-start gap-4 mb-4">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <span className="text-2xl font-bold text-primary font-sans">FM</span>
                </div>
                <div>
                  <h2 className="text-xl font-bold text-card-foreground font-sans">About Me</h2>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                    <MapPin className="w-4 h-4" />
                    <span className="font-sans">Philippines</span>
                  </div>
                </div>
              </div>
              <p className="text-card-foreground leading-relaxed font-sans flex-1 text-sm">
                I'm Felix Macaspac, a passionate HubSpot CMS developer from the Philippines with 5 years of experience
                building scalable web applications and custom CMS solutions. I specialize in HubSpot development,
                creating seamless user experiences and optimizing content management workflows. When I'm not coding,
                you'll find me exploring new web technologies and contributing to the developer community.
              </p>
              <div className="flex flex-wrap gap-2 mt-4">
                <Badge variant="secondary" className="font-sans text-xs rounded-full">
                  HubSpot CMS
                </Badge>
                <Badge variant="secondary" className="font-sans text-xs rounded-full">
                  JavaScript
                </Badge>
                <Badge variant="secondary" className="font-sans text-xs rounded-full">
                  React
                </Badge>
                <Badge variant="secondary" className="font-sans text-xs rounded-full">
                  Node.js
                </Badge>
              </div>
            </div>
          </Card>

          {/* Experience - Medium Card (Top Middle) */}
          <Card
            id="experience"
            className="md:col-span-3 lg:col-span-2 p-8 bg-gradient-to-br from-card to-card/50 border border-border/50 relative overflow-hidden rounded-3xl shadow-sm"
          >
            <div className="relative z-10">
              <h3 className="font-bold text-card-foreground mb-4 font-sans">Experience</h3>
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-bold text-primary font-sans">TC</span>
                  </div>
                  <div className="flex-1">
                    <h4 className="font-semibold text-card-foreground font-sans text-sm">
                      Senior Full Stack Developer
                    </h4>
                    <p className="text-xs text-muted-foreground font-sans">TechCorp Inc. • 2022 - Present</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-bold text-primary font-sans">ST</span>
                  </div>
                  <div className="flex-1">
                    <h4 className="font-semibold text-card-foreground font-sans text-sm">Full Stack Developer</h4>
                    <p className="text-xs text-muted-foreground font-sans">StartupXYZ • 2020 - 2022</p>
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {/* Status - Square Card (Top Right) */}
          <Card className="md:col-span-1 lg:col-span-1 p-8 bg-gradient-to-br from-card to-card/50 border border-border/50 relative overflow-hidden rounded-3xl shadow-sm">
            <div className="relative z-10">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-3 h-3 rounded-full bg-primary animate-pulse"></div>
                <h3 className="font-semibold text-card-foreground font-sans">Available</h3>
              </div>
              <p className="text-sm text-muted-foreground mb-4 font-sans">Open to new opportunities</p>
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground font-sans">Projects</span>
                  <span className="font-semibold text-card-foreground font-sans">25+</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground font-sans">Experience</span>
                  <span className="font-semibold text-card-foreground font-sans">5 years</span>
                </div>
              </div>
            </div>
          </Card>

          {/* Social Links - Square Card (Bottom Left) */}
          <Card
            id="contact"
            className="md:col-span-1 lg:col-span-1 p-8 bg-gradient-to-br from-card to-card/50 border border-border/50 relative overflow-hidden rounded-3xl shadow-sm"
          >
            <div className="relative z-10">
              <h3 className="font-semibold text-card-foreground mb-4 font-sans">Connect</h3>
              <div className="space-y-3">
                <a
                  href="#"
                  className="flex items-center gap-3 text-card-foreground hover:text-primary hover:translate-x-1 transition-all duration-200"
                >
                  <Github className="w-4 h-4" />
                  <span className="text-sm font-sans">GitHub</span>
                </a>
                <a
                  href="#"
                  className="flex items-center gap-3 text-card-foreground hover:text-primary hover:translate-x-1 transition-all duration-200"
                >
                  <Linkedin className="w-4 h-4" />
                  <span className="text-sm font-sans">LinkedIn</span>
                </a>
                <a
                  href="#"
                  className="flex items-center gap-3 text-card-foreground hover:text-primary hover:translate-x-1 transition-all duration-200"
                >
                  <Twitter className="w-4 h-4" />
                  <span className="text-sm font-sans">Twitter</span>
                </a>
                <a
                  href="#"
                  className="flex items-center gap-3 text-card-foreground hover:text-primary hover:translate-x-1 transition-all duration-200"
                >
                  <Mail className="w-4 h-4" />
                  <span className="text-sm font-sans">Email</span>
                </a>
              </div>
            </div>
          </Card>

          {/* Selected Projects - Large Card (Bottom Right) */}
          <Card
            id="projects"
            className="md:col-span-3 lg:col-span-4 p-8 bg-gradient-to-br from-card to-card/50 border border-border/50 relative overflow-hidden rounded-3xl shadow-sm"
          >
            <div className="relative z-10">
              <h3 className="font-bold text-card-foreground mb-4 font-sans">Selected Projects</h3>
              <div className="space-y-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h4 className="font-semibold text-card-foreground font-sans">E-Commerce Platform</h4>
                    <p className="text-sm text-muted-foreground mb-2 font-sans">
                      Modern e-commerce platform with React, Node.js, and PostgreSQL featuring payment processing and
                      real-time inventory.
                    </p>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline" className="text-xs font-sans rounded-full">
                        React
                      </Badge>
                      <Badge variant="outline" className="text-xs font-sans rounded-full">
                        Node.js
                      </Badge>
                      <Badge variant="outline" className="text-xs font-sans rounded-full">
                        PostgreSQL
                      </Badge>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-3 font-sans bg-transparent hover:bg-primary/10 hover:scale-105 transition-all duration-200 rounded-full"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </Button>
                </div>

                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h4 className="font-semibold text-card-foreground font-sans">Task Management App</h4>
                    <p className="text-sm text-muted-foreground mb-2 font-sans">
                      Collaborative task management with real-time updates, drag-and-drop functionality, and team
                      features.
                    </p>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant="outline" className="text-xs font-sans rounded-full">
                        Next.js
                      </Badge>
                      <Badge variant="outline" className="text-xs font-sans rounded-full">
                        TypeScript
                      </Badge>
                      <Badge variant="outline" className="text-xs font-sans rounded-full">
                        Socket.io
                      </Badge>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-3 font-sans bg-transparent hover:bg-primary/10 hover:scale-105 transition-all duration-200 rounded-full"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* Footer */}
        <footer className="mt-12 text-center">
          <p className="text-muted-foreground text-sm font-sans">
            Built with v0.dev • © 2025 Felix Macaspac
          </p>
        </footer>
      </div>
    </div>
  )
}