"use client"

import { useRouter } from "next/navigation"
import { useTheme } from "next-themes"
import { ChevronDownIcon, LogOutIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { authClient } from "@/lib/auth-client"

export function UserMenu({ name, email }: { name: string; email: string }) {
  const router = useRouter()
  const { theme, setTheme } = useTheme()

  async function handleSignOut() {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          router.push("/login")
          router.refresh()
        },
      },
    })
  }

  const initials = (name || email || "U")
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .substring(0, 2)
    .toUpperCase()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" className="gap-2 px-2 h-9 rounded-full font-normal">
            <Avatar className="size-6">
              <AvatarFallback className="text-[10px] font-semibold">
                {initials}
              </AvatarFallback>
            </Avatar>
            <span className="max-w-[120px] truncate text-sm font-medium">
              {name || email}
            </span>
            <ChevronDownIcon
              data-icon="inline-end"
              className="text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium leading-none">{name}</p>
              <p className="text-xs leading-none text-muted-foreground truncate">
                {email}
              </p>
            </div>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <PaletteIcon data-icon="inline-start" aria-hidden="true" />
              Thème
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              <DropdownMenuGroup>
                <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
                  <DropdownMenuRadioItem value="light">
                    <SunIcon data-icon="inline-start" aria-hidden="true" />
                    Neutre (Clair)
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    <MoonIcon data-icon="inline-start" aria-hidden="true" />
                    Neutre (Sombre)
                  </DropdownMenuRadioItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioItem value="light-blue">
                    <span className="size-2.5 rounded-full bg-blue-500 shrink-0" data-icon="inline-start" aria-hidden="true" />
                    Océan (Clair)
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark-blue">
                    <span className="size-2.5 rounded-full bg-blue-400 shrink-0" data-icon="inline-start" aria-hidden="true" />
                    Océan (Sombre)
                  </DropdownMenuRadioItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioItem value="light-green">
                    <span className="size-2.5 rounded-full bg-emerald-500 shrink-0" data-icon="inline-start" aria-hidden="true" />
                    Émeraude (Clair)
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark-green">
                    <span className="size-2.5 rounded-full bg-emerald-400 shrink-0" data-icon="inline-start" aria-hidden="true" />
                    Émeraude (Sombre)
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={handleSignOut}
            variant="destructive"
            className="cursor-pointer"
          >
            <LogOutIcon aria-hidden="true" />
            Se déconnecter
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

