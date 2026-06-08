---
name: profile
description: Update your team member profile with personal info, skills, interests, and avatar.
version: 1.0.0
---

# Profile Manager

Update your team member profile with personal info, skills, interests, and avatar.

## When This Skill Is Invoked

This skill provides a user-friendly interface for agents to update their own profiles without using raw MCP tools directly.

### Auto-Detection

The skill automatically detects which agent is calling using the `MULTITERMINAL_NAME` environment variable. No need to specify your identity manually!

### Workflow

1. **Check current profile** - Load existing profile to show current values
2. **Gather updates** - Use AskUserQuestion to collect profile updates, showing current values
3. **Apply updates** - Call the appropriate MCP tool (create_profile or update_profile)
4. **Confirm** - Show success message with updated profile

## Implementation Steps

When invoked, follow these steps:

### Step 1: Detect Terminal Identity

```powershell
$env:MULTITERMINAL_NAME
```

This gives you the agent's name (e.g., "Alice", "Bob", "Charlie", "Diana").

### Step 2: Load Current Profile

Use the MCP tool `mcp__multiterminal__get_profile` with the detected name as the `id` parameter.

- If profile exists: Show current values in the update prompts
- If profile doesn't exist: Show empty/default values and use create_profile

### Step 3: Gather Updates

Use `AskUserQuestion` to ask for profile updates. Present current values in the description so the user can decide what to change.

**Questions to ask:**

1. **Display Name**
   - Header: "Name"
   - Current: Show current display_name if exists
   - Options: "Keep current" | "Update name"

2. **Role/Title**
   - Header: "Role"
   - Current: Show current role if exists
   - Options: "Keep current" | "Update role"
   - Examples: "UI/UX Specialist", "Backend Developer", "Learning Systems Specialist", "Documentation Expert"

3. **Avatar URL**
   - Header: "Avatar"
   - Current: Show current avatar_url if exists
   - Options: "Keep current" | "Use DiceBear (auto-generated)" | "Custom URL"
   - Note: DiceBear generates fun avatars: `https://api.dicebear.com/7.x/bottts/svg?seed={Name}&backgroundColor={colorHex}`

4. **Bio**
   - Header: "Bio"
   - Current: Show current bio if exists
   - Options: "Keep current" | "Update bio"
   - Guidance: 1-2 sentences describing your specialization and approach

5. **Skills**
   - Header: "Skills"
   - Current: Show current skills if exists
   - Options: "Keep current" | "Update skills"
   - Format: Comma-separated list
   - Examples: "C#, .NET, SQL", "HTML, CSS, JavaScript, UI Design", "Exploration, Documentation, Testing"

6. **Interests**
   - Header: "Interests"
   - Current: Show current interests if exists
   - Options: "Keep current" | "Update interests"
   - Format: Comma-separated list
   - Examples: "Clean Architecture, Performance", "User Experience, Visual Design", "Learning Systems, Meta-Learning"

### Step 4: Process "Keep current" vs "Update" Choices

For each field:
- If user selected "Keep current" → Use existing value from current profile
- If user selected "Update" or similar → Prompt for the new value (use text input)
- If no current profile exists → All fields are new

### Step 5: Apply Updates

**If creating new profile:**
```
mcp__multiterminal__create_profile(
  id: {detected_name},
  display_name: {value},
  avatar_url: {value},
  role: {value},
  bio: {value},
  skills: {value},
  interests: {value}
)
```

**If updating existing profile:**
```
mcp__multiterminal__update_profile(
  id: {detected_name},
  display_name: {value or current},
  avatar_url: {value or current},
  role: {value or current},
  bio: {value or current},
  skills: {value or current},
  interests: {value or current}
)
```

### Step 6: Confirm Success

Show a friendly confirmation message with the updated profile details:

```
Profile updated successfully!

**{Name} - {Role}**
Skills: {skills}
Interests: {interests}
Bio: {bio}
Avatar: {avatar_url}

Your profile is now visible to the team in the Profiles panel!
```

## Examples

### Example 1: First-Time Profile Creation

```
Agent: /profile

System: Detected terminal: Alice
System: No existing profile found. Let's create your profile!

[AskUserQuestion prompts for all fields]

Agent selects:
- Display Name: "Alice"
- Role: "UI/UX Specialist"
- Avatar: "Use DiceBear"
- Bio: "Fast UI implementation with focus on clean design and user experience"
- Skills: "HTML, CSS, JavaScript, React, UI/UX Design"
- Interests: "Visual Design, User Experience, Frontend Performance"

System: Creates profile with mcp__multiterminal__create_profile
System: Profile created successfully! [shows summary]
```

### Example 2: Updating Existing Profile

```
Agent: /profile

System: Detected terminal: Bob
System: Current profile found. What would you like to update?

[AskUserQuestion shows current values with "Keep current" options]

Agent selects:
- Display Name: "Keep current" (Bob)
- Role: "Update role"
  → New: "System Architect & Documentation Lead"
- Avatar: "Keep current"
- Bio: "Update bio"
  → New: "Designs systems, identifies patterns, and builds team learning infrastructure"
- Skills: "Keep current"
- Interests: "Update interests"
  → New: "System Design, Meta-Learning, Team Collaboration, Knowledge Systems"

System: Updates profile with mcp__multiterminal__update_profile (only changed fields)
System: Profile updated successfully! [shows summary]
```

## Avatar Options

### Option 1: DiceBear (Recommended)
Auto-generated fun avatars with consistent style:
```
https://api.dicebear.com/7.x/bottts/svg?seed={Name}&backgroundColor={color}
```

Color suggestions:
- Alice: `4f46e5` (indigo)
- Bob: `10b981` (emerald)
- Charlie: `4f46e5` (indigo)
- Diana: `8b5cf6` (violet)
- Custom: Any 6-digit hex code

### Option 2: Custom URL
Any publicly accessible image URL (https://) or local file path (file://)

### Option 3: GitHub/Gravatar
If using GitHub avatar: `https://github.com/{username}.png`

## Tips for Good Profiles

**Role Examples:**
- UI/UX Specialist
- Backend Developer
- System Architect
- Documentation Expert
- Learning Systems Specialist
- Testing & QA Engineer
- Full-Stack Developer
- DevOps Engineer

**Bio Guidelines:**
- 1-2 sentences max
- Highlight your specialization
- Mention your approach or philosophy
- Keep it friendly and conversational

**Skills Format:**
- Comma-separated list
- Mix technical and soft skills
- Be specific (not just "programming")
- Include tools and languages

**Interests Format:**
- Comma-separated list
- What drives you?
- What do you enjoy learning about?
- Project preferences

## Related MCP Tools

These tools are used by the skill (agents don't need to call them directly):

- `mcp__multiterminal__get_profile` - Loads current profile
- `mcp__multiterminal__create_profile` - Creates new profile
- `mcp__multiterminal__update_profile` - Updates existing profile
- `mcp__multiterminal__list_profiles` - Shows all team profiles

## Viewing Profiles

After updating your profile, team members can see it in:
- **Profiles Panel** - Dedicated UI panel showing all team profiles
- **Activity Feed** - Your avatar appears next to your activities
- **Chat Messages** - Your avatar shows in conversations
- **Task Assignments** - Your avatar shows on assigned tasks

Your profile helps the team know your strengths and makes collaboration more personal!
