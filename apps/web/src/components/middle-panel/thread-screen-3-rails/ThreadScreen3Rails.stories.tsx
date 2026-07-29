import type { Meta, StoryObj } from "@storybook/react-vite";

import { MessageAssistant } from "../message-assistant/MessageAssistant";
import { MessageUser } from "../message-user/MessageUser";
import { ThreadScreen3Rails } from "./ThreadScreen3Rails";

const transcript = Array.from({ length: 4 }, (_, index) => (
  <div className="contents" key={index}>
    <MessageUser>Continue with the implementation and verify the result.</MessageUser>
    <MessageAssistant>
      Implemented locally. The production recipient list remains separate from active in-app
      administrators.
    </MessageAssistant>
  </div>
));

const meta = {
  args: { children: transcript },
  component: ThreadScreen3Rails,
  parameters: {
    layout: "fullscreen",
    pencil: {
      componentId: "y0DmC",
      groupId: "e46ib4",
      relatedId: "X3cN0l",
      scrollRegionId: "PGsVQ",
    },
  },
  title: "Middle Panel/Thread Screen/3 Rails",
} satisfies Meta<typeof ThreadScreen3Rails>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
